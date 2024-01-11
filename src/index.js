const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const dateFns = require('date-fns');

const core = require('@actions/core');
const github = require('@actions/github');

const createRateLimiter = ({ interval = 1000 }) => {
  const queue = [];
  let counter = 0;
  let running = false;

  const rateLimiter = {
    run: async fn => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      counter += 1;
      if (!running) {
        const handle = setInterval(
          () => {
            if (queue.length > 0) {
              const task = queue.shift();
              running = true;
              task.fn()
                .then(task.resolve)
                .catch(task.reject)
                .finally(() => {
                  counter -= 1;
                  if (counter === 0) {
                    clearInterval(handle);
                    running = false;
                  }
                });
            }
          },
          interval
        );
        running = true;
      }
    }),
  };

  return rateLimiter;
};

const rateLimiter = createRateLimiter({ interval: 1000 });

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

async function getReviewLoadingOfUser(username, menteesList = []) {
  const MENTEE_PULL_WEIGHT_RATIO = 0.5;
  core.info(`  > calculating:${username}, mentee: ${JSON.stringify(menteesList)}`);

  const dateOf2WeeksAgo = dateFns.formatISO(
    dateFns.sub(new Date, { weeks: 2 }),
    { representation: 'date' }
  );
  const baseCriteria = `is:pr user:iCHEF created:>${dateOf2WeeksAgo} -label:"auto-pr" -label:"merge request" -author:app/github-actions -author:ichefbot`;

  const {
    data: { total_count: countOfRequestedPulls },
  } = await rateLimiter.run(() => octokit.search.issuesAndPullRequests({
    q: `${baseCriteria} review-requested:${username}`,
  }));
  const {
    data: { total_count: countOfReviewdPulls },
  } = await rateLimiter.run(() => octokit.search.issuesAndPullRequests({
    q: `${baseCriteria} reviewed-by:${username} -author:${username}`,
  }));

  const totalCountOfPulls = countOfRequestedPulls + countOfReviewdPulls;

  // if has no mentee
  if (menteesList.length < 1) {
    return totalCountOfPulls;
  }

  const queryStringForMentee = menteesList
    .map(mentee => `author:${mentee}`)
    .join(' ');

  const {
    data: { total_count: countOfRequestedPullsFromMentee },
  } = await rateLimiter.run(() => octokit.search.issuesAndPullRequests({
    q: `${baseCriteria} review-requested:${username} ${queryStringForMentee}`,
  }));
  const {
    data: { total_count: countOfReviewdPullsFromMentee },
  } = await rateLimiter.run(() => octokit.search.issuesAndPullRequests({
    q: `${baseCriteria} reviewed-by:${username} ${queryStringForMentee}`,
  }));

  return totalCountOfPulls
    - (countOfRequestedPullsFromMentee * MENTEE_PULL_WEIGHT_RATIO)
    - (countOfReviewdPullsFromMentee * MENTEE_PULL_WEIGHT_RATIO);
}

async function getUsersSortedByReviewLoading(usernamesList, mentorMap) {
  const usersWithReviewLoading = await Promise.all(usernamesList.map(async username => {
    const menteesList = Object.entries(mentorMap)
      .filter(([_, mentorName]) => mentorName === username)
      .map(([mentee]) => mentee);

    return {
      username,
      reviewLoading: await getReviewLoadingOfUser(username, menteesList),
    };
  }));

  return _.sortBy(usersWithReviewLoading, 'reviewLoading');
};

async function getReviewers(author, initialReviewers = []) {
  let reviewers = [];
  const config = await fetchAndParseReviewers();
  const targetCount = core.getInput('count') - initialReviewers.length;

  core.info(`Taking ${targetCount} reviewers.`);

  // start from mentor and team members
  const mentor = config.mentors[author];
  const belongingTeamMembers = await getUsersSortedByReviewLoading(
    _.difference(
      Object.values(config.teams).find(teamMembers => teamMembers.includes(author)),
      initialReviewers,
      [author, mentor]
    ),
    config.mentors
  );

  const firstBatchCandidates = mentor
      ? ([
        { username: mentor, reviewLoading: '(mentor)'},
        ...belongingTeamMembers,
      ])
      : belongingTeamMembers;

  reviewers = _.take(firstBatchCandidates, targetCount);
  reviewers.forEach(({ username, reviewLoading }) => {
    core.info(`Taking from team: ${username} (loading=${reviewLoading}).\n`);
  });

  // if not enought, take from mentorship group
  if (reviewers.length < targetCount) {
    const mentorshipGroupMembers = await getUsersSortedByReviewLoading(
      _.difference(
        config.mentorshipGroups.find(group => group.includes(author)),
        initialReviewers,
        reviewers.map(({ username }) => username),
        [author]
      ),
      config.mentors
    );
    const remainingCount = targetCount - reviewers.length;
    const extraReviewers = _.take(mentorshipGroupMembers, remainingCount);
    extraReviewers.forEach(({ username, reviewLoading }) => {
      core.info(`Taking from mentorship group: ${username} (loading=${reviewLoading}).\n`);
    });

    reviewers = reviewers.concat(extraReviewers);
  }

  return reviewers.map(({ username }) => username);
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
