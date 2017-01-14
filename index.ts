const phantom = require('phantom');
const LocalStorage = require('node-localstorage').LocalStorage;
const _ = require('underscore-node');
const nodemailer = require('nodemailer');
const format = require('date-format');
const GitHubApi = require("github");
const childProcess = require('child_process')

localStorage = new LocalStorage('./data');
const filters = JSON.parse(localStorage.getItem('filters') || "[]");
const config = JSON.parse(localStorage.getItem('config') || "{}");
const github = new GitHubApi();

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(page, condition, timeout = 10000, ...args: any[]) {
  var evalArguments = [condition].concat(args);
  while (timeout > 0 && !(await page.evaluate.apply(page, evalArguments))) {
    timeout -= 100;
    await delay(100);
  }

  if (timeout <= 0) {
    localStorage.setItem('lastErrorPage', await page.property('content'));
    throw `Timeout expired evaluating ${condition}`
  }
}

function testPost(post, filters) {
  let text = post.text.replace(/\s+/g, ' ');
  if (!_.all(
    filters.termRules,
    filter => {
      const termIndex = text.indexOf(filter.term);
      return termIndex !== -1 &&
        !_.any(
          filter.pre,
          pre =>
            text.lastIndexOf(pre, termIndex) !== -1 &&
            text.lastIndexOf(pre, termIndex) + pre.length + 5 > termIndex) &&
        !_.any(
          filter.post,
          post =>
            text.indexOf(post, termIndex) !== -1 &&
            termIndex + filter.term.length + 5 > text.indexOf(post, termIndex));
    }
  )) {
    return false;
  }

  const numbers =
    _.map(
      text.match(/[\d,]+/g),
      number => parseInt(number.replace(',', '')));
  if (!_.any(
    numbers,
    number => number >= filters.priceRange.low && number <= filters.priceRange.high)) {
    return false;
  }

  return true;
}

function log(message) {
  console.log(`[${format.asString('dd/MM/yyyy hh:mm:ss.SSS', new Date())}] ${message}`);
}

async function processGroup(groupId: string) {
  const postsIndex = JSON.parse(localStorage.getItem('posts') || '{}');
  const instance = await phantom.create();
  const page = await instance.createPage();

  await page.setting('userAgent', 'User-Agent: Mozilla/5.0 (Windows NT 6.3; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/55.0.2883.87 Safari/537.36');

  log("reading facebook posts");
  await page.open('https://en-us.facebook.com/');

  await page.evaluate(
    function (user, password) {
      (document.getElementById('email') as any).value = user;
      (document.getElementById('pass') as any).value = password;
      (document.getElementById('loginbutton') as any).firstChild.click();
    },
    config.fb_user,
    config.fb_pass);
  await waitFor(page, function () { return document.getElementById('topnews_main_stream_408239535924329') !== null; });

  await page.open(`https://www.facebook.com/groups/${groupId}/`);
  await waitFor(
    page,
    function (groupId) { return document.getElementById('group_mall_' + groupId) !== null; },
    10000,
    groupId);

  await page.evaluate(function () {
    document.body.scrollTop = 50000;
  });
  await delay(1000);

  const posts = await page.evaluate(
    function (groupId) {
      var posts = document.getElementById('group_mall_' + groupId).getElementsByClassName('userContent');
      var postsData = [];
      for (var index = 0; index < posts.length; index++) {
        try {
          var post: any = posts[index];
          var showMore = post.getElementsByClassName('text_exposed_show')[0];
          var postId = /mall_post_(\d+):\d+:\d+/.exec(post.parentElement.parentElement.parentElement.parentElement.parentElement.id)[1];
          postsData.push({
            id: groupId + ':' + postId,
            text: post.innerText + (showMore ? showMore.innerText : ''),
            link: 'https://www.facebook.com/groups/' + groupId + '/permalink/' + postId
          });
        } catch (error) {
        }
      }
      return postsData;
    },
    groupId);

  log(`found ${posts.length} posts`);
  const newPosts = _.filter(
    posts,
    post => !postsIndex[post.id])
  let matches = [];
  if (newPosts.length === 0) {
    log("no new posts");
  } else {
    log(`processing ${newPosts.length} new posts`);

    matches = _.filter(
      newPosts,
      post => testPost(post, filters));
    if (matches.length === 0) {
      log(`no matching posts found`);
    } else {
      log(`found ${matches.length} new matching posts`);
      var transporter = nodemailer.createTransport(`smtps://${config.gmail_user}%40gmail.com:${config.gmail_pass}@smtp.gmail.com`);
      var mailOptions = {
        from: `${config.gmail_user}@gmail.com`,
        to: config.gmail_to_address,
        subject: 'New apartment matches',
        html: _.map(
          matches,
          match =>
            `<div style="margin-top: 20px;"><div style="font-size: 14px;">${match.text}</div>` +
            `<div style="font-size: 12px;">${match.link}</div></div>`).join("")
      };
      transporter.sendMail(mailOptions);

      let currentMatches = JSON.parse(localStorage.getItem('matches') || "[]");
      matches.concat(currentMatches);
      localStorage.setItem('matches', JSON.stringify(matches, null, "  "));
    }
  }

  _.each(
    newPosts,
    post => postsIndex[post.id] = { match: false, time: new Date() });
  _.each(
    matches,
    match => postsIndex[match.id].match = true);
  localStorage.setItem('posts', JSON.stringify(postsIndex, null, "  "));
  await instance.exit();
}

async function processGroupWithRetry(groupId: string) {
  let retry = 0;
  while (retry++ < 3) {
    try {
      await processGroup(groupId);
      return;
    } catch (error) {
      log(`Failed: ${error}, retrying ${retry}...`);
      await delay(5000);
    }
  }
}

async function checkUpdates() {
  const commits = await github.repos.getCommits(
    {
      "owner": "hugo972",
      "repo": "fb-tracker"
    });

  if (commits.length > 0 && config.sha !== commits[0].sha) {
    log(`Applying update "${commits[0].commit.message}"...`);
    config.sha = commits[0].sha;
    localStorage.setItem('config', JSON.stringify(config, null, "  "));
    childProcess.execSync('git pull;npm install');
  }
}

async function run() {
  let retry = 0;
  while (true) {
    log('Checking for updates');
    await checkUpdates();

    log('Starting process');

    for (var index = 0; index < config.fb_group_ids.length; index++) {
      log(`Processing group ${config.fb_group_ids[index]}`);
      await processGroupWithRetry(config.fb_group_ids[index]);
    }

    const waitInterval = Math.round(Math.random() * 20 + 40);
    log(`Finished, waiting ${waitInterval}min for next process`);
    await delay(1000 * 60 * waitInterval);
  }
}

run().then(
  () => log('worker done'),
  reason => log(`worker failed:\n${reason}`));