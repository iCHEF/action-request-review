const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const core = require('@actions/core');
const github = require('@actions/github');

/**
 * @typedef {[]} Username
 * @typedef {Username[]} MentorshipGroup
 *
 * @typedef {object} Config
 * @prop {{ [teamId: string]: Username[] }} teams
 * @prop {MentorshipGroup[]} mentorshipGroups
 * @prop {{ [mentorId: Username]: Username}} mentors
 */

const octokit = (function getOctokit() {
  const token = core.getInput('token');
  return github.getOctokit(token);
})();

async function fetchAndParseReviewers() {
  const gistId = core.getInput('config_gist_id');

  core.info(`Fetching config file from gist ID: ${gistId}`);

  const { data } = await octokit.gists.get({ gist_id: gistId });
  const firstFileName = Object.keys(data.files)[0];
  const firstFile = data.files[firstFileName];

  core.info(`Received config file: ${firstFileName}`);

  /** @type {Config} */
  const config = yaml.parse(firstFile.content);
  return config;
}

function randomPick(pickCount, candidates = []) {
  const results = [];
  const shuffledCandidates = _.shuffle(candidates);

  while (results.length < pickCount && shuffledCandidates.length > 0) {
    const candidate = shuffledCandidates.pop();
    results.push(candidate);
  }

  return results;
}

async function getReviewers(username) {
  const reviewers = [];
  const config = await fetchAndParseReviewers();

  const mentor = config.mentors[username];

  // 先抽 mentor
  if (mentor) {
    core.info(`Requesting mentor: ${mentor}`);
    reviewers.push(mentor);
  } else {
    core.info(`No mentor found.`);
  }

  // 再從同專案團隊抽 1 人
  const belongingTeamMembers = Object.values(config.teams)
    .find(teamMembers => teamMembers.includes(username))
    .filter(member => member !== username);

  const teamReviewers = randomPick(1, belongingTeamMembers);
  reviewers.push(...teamReviewers);

  core.info(`Requesting team members: ${teamReviewers}`);

  // 不夠的話從 mentorship group 抽 1 人
  if (reviewers.length < 2) {
    const mentorshipGroupMembers = config.mentorshipGroups
      .find(group => group.includes(username))
      .filter(member => member !== username);

    const candidates = _.difference(mentorshipGroupMembers, reviewers);
    const groupReviewers = randomPick(1, candidates);

    reviewers.push(...groupReviewers);

    core.info(`Requesting extra reviewers: ${groupReviewers}`);
  }

  return reviewers;
}

async function run() {
  const context = github.context;

  try {
    const author = context.payload.pull_request.user.login;
    const reviewers = await getReviewers(author);

    core.info(`Requested reviewers: ${reviewers}`);

    await octokit.pulls.requestReviewers({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      reviewers,
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

// officially run the action
run();
