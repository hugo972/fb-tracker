module report {
    const LocalStorage = require('node-localstorage').LocalStorage;
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
            (err, result) => console.log(result));
        db.close();
    }

    run().then(
        () => log('report done'),
        reason => log(`report failed:\n${reason}`));
}