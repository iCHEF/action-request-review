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

async function getReviewers(username, initialReviewers = []) {
  const reviewers = [];
  const config = await fetchAndParseReviewers();
  const targetCount = core.getInput('count');

  const mentor = config.mentors[username];

  // 先抽 mentor
  if (mentor) {
    if (initialReviewers.includes(mentor)) {
      core.info(`Mentor ${mentor} already requested.`);
    } else {
      core.info(`Requesting mentor: ${mentor}`);
      reviewers.push(mentor);
    }
  } else {
    core.info(`No mentor found.`);
  }

  // 再從同專案團隊優先抽滿
  {
    const belongingTeamMembers = Object.values(config.teams)
      .find(teamMembers => teamMembers.includes(username))
      .filter(member => member !== username);

    const candidates = _.difference(belongingTeamMembers, reviewers, initialReviewers);
    const remainingCount = targetCount - reviewers.length;
    const teamReviewers = randomPick(remainingCount, candidates);
    reviewers.push(...teamReviewers);

    core.info(`Requesting team members: ${teamReviewers}`);
  }

  // 不夠的話從 mentorship group 抽到滿
  if (reviewers.length < 2) {
    const mentorshipGroupMembers = config.mentorshipGroups
      .find(group => group.includes(username))
      .filter(member => member !== username);

    const candidates = _.difference(mentorshipGroupMembers, reviewers, initialReviewers);
    const remainingCount = targetCount - reviewers.length;
    const groupReviewers = randomPick(remainingCount, candidates);

    reviewers.push(...groupReviewers);

    core.info(`Requesting extra reviewers: ${groupReviewers}`);
  }

  return reviewers;
}

async function run() {
  const context = github.context;
  const pullRequest = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  };

  try {
    const targetCount = core.getInput('count');
    const author = context.payload.pull_request.user.login;

    const reviewedUsers = await octokit.pulls.listReviews(pullRequest)
      .then(result => result.data.map(review => review.user.login))
      .then(_.uniq)
      .then(usernames => _.without(usernames, author));

    const requestedUsers = await octokit.pulls.listRequestedReviewers(pullRequest)
      .then(result => result.data.users.map(user => user.login));

    const alreadyInvolvedUsers = [...reviewedUsers, ...requestedUsers];

    if (alreadyInvolvedUsers.length) {
      core.info(`Currently requested users: ${alreadyInvolvedUsers}`);
    }

    if (alreadyInvolvedUsers.length >= targetCount) {
      core.info(`Already meet target ${targetCount} reviewers.`);
      return;
    }

    const reviewers = await getReviewers(author, alreadyInvolvedUsers);

    await octokit.pulls.requestReviewers({
      ...pullRequest,
      reviewers,
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

// officially run the action
run();
