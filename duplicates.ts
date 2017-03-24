module deplicates {
    const _ = require('underscore-node');
    const LocalStorage = require('node-localstorage').LocalStorage;
    const moment = require('moment');
    const mongodb = require('mongodb');
    const stringSimilarity = require('string-similarity');

    const dataStorage = new LocalStorage('./data');
    const secrets = JSON.parse(dataStorage.getItem('secrets') || "{}");

    async function run() {
        const db = await mongodb.MongoClient.connect(`mongodb://${secrets.db_user}:${secrets.db_pass}@ds135039.mlab.com:35039/fbtracker`);
        const uniqueMatches = [];
        const matches = await db.collection('matches').find().toArray();
        _.each(
            matches,
            async (match) => {
                if (_.any(
                    uniqueMatches,
                    uniqueMatch => stringSimilarity.compareTwoStrings(match.text, uniqueMatch.text) > 0.75)) {
                    await db.collection('matches').deleteOne({_id: match._id});
                } else {
                    uniqueMatches.push(match);
                }
            });
        db.close();
    }

    run().then(
        () => log('deplicates done'),
        reason => log(`deplicates failed:\n${reason}`));
}