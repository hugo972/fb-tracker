module report {
    const _ = require('underscore-node');
    const LocalStorage = require('node-localstorage').LocalStorage;
    const moment = require('moment');
    const mongodb = require('mongodb');

    const dataStorage = new LocalStorage('./data');
    const secrets = JSON.parse(dataStorage.getItem('secrets') || "{}");

    async function run() {
        const db = await mongodb.MongoClient.connect(`mongodb://${secrets.db_user}:${secrets.db_pass}@ds135039.mlab.com:35039/fbtracker`);
        db.collection('posts').aggregate(
            [
                {
                    $group: {
                        _id: "$match",
                        maxDate: { $max: "$time" }
                    }
                },
            ], 
            (err, results) => {
                const report = {
                    lastMatchTime: null,
                    lastPostTime: null
                };
                _.each(
                    results,
                    result => {
                        const postTime = new Date(result.maxDate);
                        if (result._id) {
                            report.lastMatchTime = postTime;
                        }
                        report.lastPostTime = !report.lastPostTime
                            ? postTime
                            : new Date(Math.max(postTime.getTime(), report.lastPostTime.getTime()));
                    });
                console.log(`Report time: ${moment().format('L LT')}`);
                console.log(`Last post time: ${moment(report.lastPostTime).format('L LT')} (${moment(report.lastPostTime).fromNow()})`);
                console.log(`Last match time: ${moment(report.lastMatchTime).format('L LT')} (${moment(report.lastMatchTime).fromNow()})`);
            });
        db.close();
    }

    run().then(
        () => log('report done'),
        reason => log(`report failed:\n${reason}`));
}