const phantom = require('phantom');
const LocalStorage = require('node-localstorage').LocalStorage;
const _ = require('underscore-node');
const nodemailer = require('nodemailer');

localStorage = new LocalStorage('./data');
const filters = JSON.parse(localStorage.getItem('filters') || "[]");

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
    throw `Timeout expired evaluating ${condition}`
  }
}

function testPost(post, filters) {
  let text = post.text.replace(/\s+/g, ' ');
  return _.all(
    filters,
    filter => {
      const termIndex = text.indexOf(filter.term);
      return termIndex !== -1 &&
        _.all(
          filter.pre,
          pre => text.lastIndexOf(pre, termIndex) + pre.length + 5 < termIndex) &&
        _.all(
          filter.post,
          post => text.indexOf(post, termIndex) > termIndex + filter.term.length + 5);
    }
  )
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function Process() {
  const lastPostId = localStorage.getItem('lastPostId');
  const instance = await phantom.create();
  const page = await instance.createPage();
  const groupId = process.env.fb_group_id;

  log("reading facebook posts");
  await page.open('https://www.facebook.com/');

  await page.evaluate(
    function (user, password) {
      (document.getElementById('email') as any).value = user;
      (document.getElementById('pass') as any).value = password;
      (document.getElementById('loginbutton') as any).firstChild.click();
    },
    process.env.fb_user,
    process.env.fb_pass);
  await waitFor(page, function () { return document.title !== 'Facebook - Log In or Sign Up'; });

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
        var post: any = posts[index];
        var showMore = post.getElementsByClassName('text_exposed_show')[0];
        var postId = post.parentElement.parentElement.parentElement.parentElement.parentElement.id;
        try {
          postsData.push({
            id: postId,
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
  let postIndex = 0;
  while (postIndex < posts.length && posts[postIndex].id !== lastPostId) postIndex++;

  if (postIndex === 0) {
    log("no new posts");
  } else {
    posts.splice(postIndex - 1);
    log(`processing ${posts.length} new posts`);

    const matches = _.filter(
      posts,
      post => testPost(post, filters));
    if (matches.length === 0) {
      log(`no matching posts found`);
    } else {
      log(`found ${matches.length} new matching posts`);
      var transporter = nodemailer.createTransport(`smtps://${process.env.gmail_user}%40gmail.com:${process.env.gmail_pass}@smtp.gmail.com`);
      var mailOptions = {
        from: `${process.env.gmail_user}@gmail.com`,
        to: process.env.gmail_to_address,
        subject: 'New apartment matches',
        html: _.map(
          matches,
          match => `<div style="margin-top: 20px;"><div style="font-size: 14px;">${match.text}</div><div style="font-size: 12px;">${match.link}</div></div>`).join("")
      };
      transporter.sendMail(mailOptions);

      let currentMatches = JSON.parse(localStorage.getItem('matches') || "[]");
      matches.concat(currentMatches);
      localStorage.setItem('matches', JSON.stringify(matches, null, "  "));
    }
  }

  localStorage.setItem('lastPostId', posts[0].id);
  await instance.exit();
}

async function Run() {
  while (true) {
    await Process();
    await delay(1000 * 60 * Math.round(Math.random() * 20 + 40));
  }
}

function assert_env(envProperty) {
  if (!process.env[envProperty]) {
    throw `missing env variable '${envProperty}'.`;
  }
}

assert_env('fb_group_id');
assert_env('fb_user');
assert_env('fb_pass');
assert_env('gmail_user');
assert_env('gmail_pass');
assert_env('gmail_to_address');

Run().then(
  () => log('worker done'), 
  reason => log(`worker failed:\n${reason}`));