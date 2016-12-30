const phantom = require('phantom');
const LocalStorage = require('node-localstorage').LocalStorage;
const _ = require('underscore-node');
const nodemailer = require('nodemailer');

localStorage = new LocalStorage('./data');
const filters = JSON.parse(localStorage.getItem('filters') || "[]");

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(page, condition, timeout = 10000) {
  while (timeout > 0 && !(await page.evaluate(condition))) {
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

async function Process() {
  const lastPostId = localStorage.getItem('lastPostId');
  const instance = await phantom.create();
  const page = await instance.createPage();

  await page.open('https://www.facebook.com/');

  await page.evaluate(() => {
    (document.getElementById('email') as any).value = process.env.fb_user;
    (document.getElementById('pass') as any).value = process.env.fb_pass;
    (document.getElementById('loginbutton') as any).firstChild.click();
  });
  await waitFor(page, () => document.title !== 'Facebook - Log In or Sign Up');

  await page.open('https://www.facebook.com/groups/503525946346109/');
  await waitFor(page, () => document.getElementById('group_mall_503525946346109') !== null);

  await page.evaluate(() => {
    document.body.scrollTop = 50000;
  });
  await delay(1000);

  const posts = await page.evaluate(() => {
    var posts = document.getElementById('group_mall_503525946346109').getElementsByClassName('userContent');
    var postsData = [];
    for (var index = 0; index < posts.length; index++) {
      var post: any = posts[index];
      var showMore = post.getElementsByClassName('text_exposed_show')[0];
      var postId = post.parentElement.parentElement.parentElement.parentElement.parentElement.id;
      try {
        postsData.push({
          id: postId,
          text: post.innerText + (showMore ? showMore.innerText : ''),
          link: `https://www.facebook.com/groups/503525946346109/permalink/${postId}/`
        });
      } catch (error) {
      }
    }
    return postsData;
  });

  let postIndex = 0;
  while (postIndex < posts.length && posts[postIndex].id !== lastPostId) postIndex++;

  if (postIndex > 0) {
    posts.splice(postIndex - 1);

    const matches = _.filter(
      posts,
      post => testPost(post, filters));
    if (matches.length > 0) {
      var transporter = nodemailer.createTransport(`smtps://${process.env.gmail_user}%40gmail.com:${process.env.gmail_pass}@smtp.gmail.com`);
      var mailOptions = {
        from: `${process.env.gmail_user}@gmail.com`,
        to: 'msivan@microsoft.com',
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

Run();