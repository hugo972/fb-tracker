const _ = require('underscore-node');
const childProcess = require('child_process');
const GitHubApi = require("github");
const LocalStorage = require('node-localstorage').LocalStorage;
const moment = require('moment');
const mongodb = require('mongodb');
const nodemailer = require('nodemailer');
const phantom = require('phantom');
const stringSimilarity = require('string-similarity');

const dataStorage = new LocalStorage('./data');
const secrets = JSON.parse(dataStorage.getItem('secrets') || "{}");
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
    await page.render('./data/lastErrorPage.png');
    dataStorage.setItem('lastErrorPage', await page.property('content'));
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
  console.log(`[${moment().format('L LT')}] ${message}`);
}

async function processGroup(db: any, groupId: string) {
  log("loading configurations");
  const system = await db.collection('system').findOne();
  const filters = await db.collection('filters').findOne();
  const postsIndex = {};
  const instance = await phantom.create();
  const page = await instance.createPage();

  _.each(
    await db.collection('posts').find().toArray(),
    post => postsIndex[post.id] = post);

  await page.setting('userAgent', 'User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 8_0_2 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) Version/8.0 Mobile/12A366 Safari/600.1.4');

  log("login to facebook");
  await page.open('https://en-us.facebook.com/home.php');
  await waitFor(page, function () {
    return document.querySelector('[name="email"]') != null &&
      document.querySelector('[name="pass"]') != null &&
      document.querySelector('[name="login"]') != null
  });
  await page.evaluate(
    function (user, password) {
      (document.querySelector('[name="email"]') as any).value = user;
      (document.querySelector('[name="pass"]') as any).value = password;
      (document.querySelector('[name="login"]') as any).click();
    },
    secrets.fb_user,
    secrets.fb_pass);
  await waitFor(page, function () { return document.getElementById('m_newsfeed_stream') !== null; });

  log("reading facebook posts");
  await page.open(`https://www.facebook.com/groups/${groupId}/`);
  await waitFor(page, function () { return document.getElementById('m_group_stories_container') !== null; }, 10000);
  await page.evaluate(function () { document.body.scrollTop = 50000; });
  await delay(1000);

  const posts = await page.evaluate(
    function (groupId) {
      var posts = document.querySelectorAll('[data-sigil="story-div story-popup-metadata  story-popup-metadata feed-ufi-metadata"]');
      var postsData = [];
      for (var index = 0; index < posts.length; index++) {
        try {
          var post: any = posts[index];
          var postText = post.querySelector('[data-sigil="expose"]');
          var exposeElements = post.querySelectorAll('.text_exposed_show');
          var showMoreText = '';
          for (var exposeIndex = 0; exposeIndex < exposeElements.length; exposeIndex++) {
            showMoreText += exposeElements[exposeIndex].innerText;
          }
          var postId = /mf_story_key\.(\d+)/.exec(post.attributes["data-store"].value)[1];
          postsData.push({
            id: groupId + ':' + postId,
            text: postText.innerText + showMoreText,
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
      log(`processing ${matches.length} matching posts`);
      const currentMatches = await db.collection('matches').find().toArray();
      const uniqueMatches = [];
      _.each(
        matches,
        async match => {
          if (_.any(
            uniqueMatches,
            uniqueMatch => stringSimilarity.compareTwoStrings(match.text, uniqueMatch.text) > 0.75)) {
            return;
          }
          if (_.any(
            currentMatches,
            currentMatch => stringSimilarity.compareTwoStrings(match.text, currentMatch.text) > 0.75)) {
            return;
          }
          uniqueMatches.push(match);
        });

      if (uniqueMatches.length > 0) {
        log(`found ${uniqueMatches.length} new matching posts`);

        var transporter = nodemailer.createTransport(`smtps://${secrets.gmail_user}%40gmail.com:${secrets.gmail_pass}@smtp.gmail.com`);
        var mailOptions = {
          from: `${secrets.gmail_user}@gmail.com`,
          to: system.notification_email_address,
          subject: 'New apartment matches',
          html: _.map(
            uniqueMatches,
            match =>
              `<div style="margin-top: 20px;"><div style="font-size: 14px;">${match.text}</div>` +
              `<div style="font-size: 12px;">${match.link}</div></div>`).join("")
        };
        transporter.sendMail(mailOptions);

        db.collection('matches').insertMany(uniqueMatches);
      }
    }
  }

  db.collection('posts').insertMany(
    _.map(
      newPosts,
      post => ({
        id: post.id,
        match: !!_.find(matches, match => match.id === post.id),
        time: new Date()
      })));
  await instance.exit();
}

async function processGroupWithRetry(db: any, groupId: string) {
  let retry = 0;
  while (retry++ < 3) {
    try {
      await processGroup(db, groupId);
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

  if (commits.length > 0 && secrets.sha !== commits[0].sha) {
    log(`Applying update "${commits[0].commit.message}"...`);
    secrets.sha = commits[0].sha;
    dataStorage.setItem('secrets', JSON.stringify(secrets, null, "  "));
    childProcess.execSync('git pull;npm install');
  }
}

async function run() {
  const db = await mongodb.MongoClient.connect(`mongodb://${secrets.db_user}:${secrets.db_pass}@ds135039.mlab.com:35039/fbtracker`);
  const system = await db.collection('system').findOne();
  let retry = 0;
  while (true) {
    log('Checking for updates');
    //await checkUpdates();

    log('Starting process');

    for (var index = 0; index < system.facebook_group_ids.length; index++) {
      log(`Processing group ${system.facebook_group_ids[index]}`);
      await processGroupWithRetry(db, system.facebook_group_ids[index]);
    }

    const waitInterval = Math.round(Math.random() * 20 + 40);
    log(`Finished, waiting ${waitInterval}min for next process`);
    await delay(1000 * 60 * waitInterval);
  }
}

run().then(
  () => log('worker done'),
  reason => log(`worker failed:\n${reason}`));