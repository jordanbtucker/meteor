var OplogCollection = new Mongo.Collection("oplog-" + Random.id());

Tinytest.addAsync("mongo-livedata - oplog - cursorSupported", async function (test) {
  var oplogEnabled =
        !!(await MongoInternals.defaultRemoteCollectionDriver()).mongo._oplogHandle;

  var supported = function (expected, selector, options) {
    var cursor = OplogCollection.find(selector, options);
    var handle = cursor.observeChanges({added: function () {}});
    // If there's no oplog at all, we shouldn't ever use it.
    if (!oplogEnabled)
      expected = false;
    test.equal(!!handle._multiplexer._observeDriver._usesOplog, expected);
    handle.stop();
  };

  supported(true, "asdf");
  supported(true, 1234);
  supported(true, new Mongo.ObjectID());

  supported(true, {_id: "asdf"});
  supported(true, {_id: 1234});
  supported(true, {_id: new Mongo.ObjectID()});

  supported(true, {foo: "asdf",
                   bar: 1234,
                   baz: new Mongo.ObjectID(),
                   eeney: true,
                   miney: false,
                   moe: null});

  supported(true, {});

  supported(true, {$and: [{foo: "asdf"}, {bar: "baz"}]});
  supported(true, {foo: {x: 1}});
  supported(true, {foo: {$gt: 1}});
  supported(true, {foo: [1, 2, 3]});

  // No $where.
  supported(false, {$where: "xxx"});
  supported(false, {$and: [{foo: "adsf"}, {$where: "xxx"}]});
  // No geoqueries.
  supported(false, {x: {$near: [1,1]}});
  // Nothing Minimongo doesn't understand.  (Minimongo happens to fail to
  // implement $elemMatch inside $all which MongoDB supports.)
  supported(false, {x: {$all: [{$elemMatch: {y: 2}}]}});

  supported(true, {}, { sort: {x:1} });
  supported(true, {}, { sort: {x:1}, limit: 5 });
  supported(false, {}, { sort: {$natural:1}, limit: 5 });
  supported(false, {}, { limit: 5 });
  supported(false, {}, { skip: 2, limit: 5 });
  supported(false, {}, { skip: 2 });
});

process.env.MONGO_OPLOG_URL && testAsyncMulti(
  "mongo-livedata - oplog - entry skipping", [
    async function (test, expect) {
      var self = this;
      self.collectionName = Random.id();
      self.collection = new Mongo.Collection(self.collectionName);
      self.collection.createIndex({species: 1});

      // Fill collection with lots of irrelevant objects (red cats) and some
      // relevant ones (blue dogs).

      // After updating to mongo 3.2 with the 2.1.18 driver it was no longer
      // possible to make this test fail with TOO_FAR_BEHIND = 2000.
      // The documents waiting to be processed would hardly go beyond 1000
      // using mongo 3.2 with WiredTiger
      (await MongoInternals.defaultRemoteCollectionDriver())
        .mongo._oplogHandle._defineTooFarBehind(500);

      self.IRRELEVANT_SIZE = 15000;
      self.RELEVANT_SIZE = 10;
      var docs = [];
      var i;
      for (i = 0; i < self.IRRELEVANT_SIZE; ++i) {
        docs.push({
          name: "cat " + i,
          species: 'cat',
          color: 'red'
        });
      }
      for (i = 0; i < self.RELEVANT_SIZE; ++i) {
        docs.push({
          name: "dog " + i,
          species: 'dog',
          color: 'blue'
        });
      }
      // XXX implement bulk insert #1255
      var rawCollection = self.collection.rawCollection();
      rawCollection.insert(docs, Meteor.bindEnvironment(expect(function (err) {
        test.isFalse(err);
      })));
    },

    async function (test, expect) {
      var self = this;

      test.equal(self.collection.find().count(),
                 self.IRRELEVANT_SIZE + self.RELEVANT_SIZE);

      var blueDog5Id = null;
      var gotSpot = false;

      // Watch for blue dogs.
      const gotSpotPromise = new Promise(resolve => {
        self.subHandle = self.collection.find({
          species: 'dog',
          color: 'blue',
        }).observeChanges({
          added(id, fields) {
            if (fields.name === 'dog 5') {
              blueDog5Id = id;
            }
          },
          changed(id, fields) {
            if (EJSON.equals(id, blueDog5Id) &&
                fields.name === 'spot') {
              gotSpot = true;
              resolve();
            }
          },
        });
      });

      test.isTrue(self.subHandle._multiplexer._observeDriver._usesOplog);
      test.isTrue(blueDog5Id);
      test.isFalse(gotSpot);

      self.skipped = false;
      self.skipHandle = (await MongoInternals.defaultRemoteCollectionDriver())
        .mongo._oplogHandle.onSkippedEntries(function () {
          self.skipped = true;
        });

      // Dye all the cats blue. This adds lots of oplog mentries that look like
      // they might in theory be relevant (since they say "something you didn't
      // know about is now blue", and who knows, maybe it's a dog) which puts
      // the OplogObserveDriver into FETCHING mode, which performs poorly.
      self.collection.update({species: 'cat'},
                             {$set: {color: 'blue'}},
                             {multi: true});
      self.collection.update(blueDog5Id, {$set: {name: 'spot'}});

      // We ought to see the spot change soon!
      return gotSpotPromise;
    },

    async function (test, expect) {
      var self = this;
      test.isTrue(self.skipped);

      //This gets the TOO_FAR_BEHIND back to its initial value
      (await MongoInternals.defaultRemoteCollectionDriver())
        .mongo._oplogHandle._resetTooFarBehind();

      self.skipHandle.stop();
      self.subHandle.stop();
      self.collection.remove({});
    }
  ]
);
