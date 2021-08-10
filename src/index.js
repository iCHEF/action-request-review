const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const dateFns = require('date-fns');

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

async function getReviewLoadingOfUser(username) {
  const dateOf2WeeksAgo = dateFns.formatISO(
    dateFns.sub(new Date, { weeks: 2 }),
    { representation: 'date' }
  );

  const {
    data: { total_count: countOfRequestedPulls },
  } = await octokit.search.issuesAndPullRequests({
    q: `is:pr user:iCHEF review-requested:${username} created:>${dateOf2WeeksAgo}`,
  });

  const {
    data: { total_count: countOfReviewdPulls },
  } = await octokit.search.issuesAndPullRequests({
    q: `is:pr user:iCHEF reviewed-by:${username} created:>${dateOf2WeeksAgo}`,
  });

  return countOfRequestedPulls + countOfReviewdPulls;
}

async function getUsersSortedByReviewLoading(usernamesList) {
  const usersWithReviewLoading = await Promise.all(
    usernamesList.map(async username => ({
      username,
      reviewLoading: await getReviewLoadingOfUser(username),
    }))
  );

  return _.sortBy(usersWithReviewLoading, 'reviewLoading');
};

function getReviewers(author, initialReviewers = []) {
  const targetCount = core.getInput('count') - initialReviewers.length;
  let config;

  return fetchAndParseReviewers()
    .then((fetchedConfig) => {
      config = fetchedConfig;
      core.info(`Taking ${targetCount} reviewers.`);
    })
    // start from mentor
    .then(() => {
      const mentor = config.mentors[author];

      if (mentor && !initialReviewers.includes(mentor)) {
        core.info(`Taking mentor: ${mentor}`);
        return [[mentor], targetCount - 1];
      }
      return [[], targetCount];
    })
    // if not enought, take from team members
    .then(async ([reviewers, remainingCount]) => {
      if (remainingCount <= 0) {
        return [reviewers, remainingCount];
      }

      const belongingTeamMembers = await getUsersSortedByReviewLoading(
        _.difference(
          Object.values(config.teams).find(teamMembers => teamMembers.includes(author)),
          reviewers,
          [author]
        )
      );
      const reviewersFromTeam = _.take(belongingTeamMembers, remainingCount);
      reviewersFromTeam.forEach(({ username, reviewLoading }) => {
        core.info(`Taking from team: ${username} (loading=${reviewLoading}).`);
      });

      return [
        [...reviewers, ...reviewersFromTeam],
        remainingCount - reviewersFromTeam.length,
      ];
    })
    // if still not enought, take from mentorship group
    .then(async ([reviewers, remainingCount]) => {
      if (remainingCount <= 0) {
        return [reviewers, remainingCount];
      }

      const mentorshipGroupMembers = await getUsersSortedByReviewLoading(
        _.difference(
          config.mentorshipGroups.find(group => group.includes(author)),
          reviewers,
          [author]
        )
      );
      const reviewersFromMentorship = _.take(mentorshipGroupMembers, remainingCount);
      reviewersFromMentorship.forEach(({ username, reviewLoading }) => {
        core.info(`Taking from mentorship group: ${username} (loading=${reviewLoading}).`);
      });

      return [...reviewers, ...reviewersFromMentorship];
    })
    .then(reviewers => reviewers.map(({ username }) => username));
}

async function run() {
  const context = github.context;

  // skip draft pull request
  if (context.payload.pull_request.draft) {
    return;
  }

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

    if (alreadyInvolvedUsers.length > 0) {
      core.info(`Currently requested users: ${alreadyInvolvedUsers}`);
    }

    if (alreadyInvolvedUsers.length >= targetCount) {
      core.info(`Already meet target ${targetCount} reviewers.`);
      return;
    }

    const reviewers = await getReviewers(author, alreadyInvolvedUsers);

    core.info(`Requested reviewers: ${reviewers}`);

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
