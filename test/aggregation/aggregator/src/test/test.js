'use strict';

const cp = require('child_process');
const _ = require('underscore');

const commander = require('commander');

const batch = require('abacus-batch');
const throttle = require('abacus-throttle');
const request = require('abacus-request');
const router = require('abacus-router');
const express = require('abacus-express');

const map = _.map;
const range = _.range;
const clone = _.clone;
const omit = _.omit;

// Batch the requests
const brequest = batch(request);

// Setup the debug log
const debug = require('abacus-debug')('abacus-usage-aggregator-itest');

// Parse command line options
const argv = clone(process.argv);
argv.splice(1, 1, 'usage-aggregator-itest');
commander
  .option('-o, --orgs <n>', 'number of organizations', parseInt)
  .option('-i, --instances <n>', 'number of resource instances', parseInt)
  .option('-u, --usagedocs <n>', 'number of usage docs', parseInt)
  .option('-d, --day <d>',
    'usage time shift using number of days', parseInt)
  .allowUnknownOption(true)
  .parse(argv);

// Number of organizations
const orgs = commander.orgs || 1;

// Number of resource instances
const resourceInstances = commander.instances || 1;

// Number of usage docs
const usage = commander.usagedocs || 1;

// Usage time shift by number of days in milli-seconds
const tshift = commander.day * 24 * 60 * 60 * 1000 || 0;

// Return the aggregation start time for a given time
const day = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

// Return the aggregation end time for a given time
const eod = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(),
    d.getUTCDate() + 1) - 1;
};

// Module directory
const moduleDir = (module) => {
  const path = require.resolve(module);
  return path.substr(0, path.indexOf(module + '/') + module.length);
};

describe('abacus-usage-aggregator-itest', () => {
  before(() => {
    const start = (module) => {
      const c = cp.spawn('npm', ['run', 'start'],
        { cwd: moduleDir(module), env: clone(process.env) });

      // Add listeners to stdout, stderr and exit messsage and forward the
      // messages to debug logs
      c.stdout.on('data', (d) => process.stdout.write(d));
      c.stderr.on('data', (d) => process.stderr.write(d));
      c.on('exit', (c) => debug('Application exited with code %d', c));
    };

    // Start local database server
    start('abacus-dbserver');

    // Start usage aggregator
    start('abacus-usage-aggregator');
  });

  after(() => {
    const stop = (module) => {
      cp.spawn('npm', ['run', 'stop'],
        { cwd: moduleDir(module), env: clone(process.env) });
    };

    // Stop usage aggregator
    stop('abacus-usage-aggregator');

    // Stop local database server
    stop('abacus-dbserver');
  });

  it('aggregate accumulated usage submissions', function(done) {
    // Configure the test timeout based on the number of usage docs, with
    // a minimum of 20 secs
    const timeout = Math.max(20000,
      100 * orgs * resourceInstances * usage);
    this.timeout(timeout + 2000);

    // Setup rate spy
    const rate = spy((req, res, next) => { res.status(201).send(); });

    // Start usage rate stub with the rate spy
    const app = express();
    const routes = router();
    routes.post('/v1/rating/usage', rate);
    app.use(routes);
    app.use(router.batch(routes));
    app.listen(9410);

    // Initialize usage doc properties with unique values
    const start = 1435629365220 + tshift;
    const end = 1435629465220 + tshift;

    const oid = (o) => ['a3d7fe4d-3cb1-4cc3-a831-ffe98e20cf27',
      o + 1].join('-');
    const rid = (o) => o % 2 === 0 ? 'us-south' : 'eu-gb';
    const sid = (o, ri) => ['aaeae239-f3f8-483c-9dd0-de5d41c38b6a',
      o + 1, ri % 2 === 0 ? 1 : 2].join('-');
    const cid = (o, ri) => ['bbeae239-f3f8-483c-9dd0-de6781c38bab',
      o + 1, ri % 2 === 0 ? 1 : 2, ri % 8 < 4 ? 1 : 2].join('-');
    const pid = (ri) => ri % 4 < 2 ? 'basic' : 'advanced';

    const riid = (o, ri) => ['0b39fa70-a65f-4183-bae8-385633ca5c87',
      o + 1, ri + 1].join('-');

    const uid = (o, ri, u) => [start, o + 1, ri + 1, u + 1].join('-');
    const bid = (u) => [start, u + 1].join('-');

    // Accumulated usage for given org, resource instance and usage #s
    const accumulatedTemplate = (o, ri, u) => ({
      id: uid(o, ri, u),
      usage_batch_id: bid(o, ri, u),
      start: start + u,
      end: end + u,
      region: rid(o),
      organization_id: oid(o),
      space_id: sid(o, ri),
      resource_id: 'object-storage',
      resource_instance_id: riid(o, ri),
      plan_id: pid(ri, u),
      consumer: { type: 'EXTERNAL', consumer_id: cid(o, ri) },
      measured_usage: [
        { measure: 'storage', quantity: 1073741824 },
        { measure: 'light_api_calls', quantity: 1000 },
        { measure: 'heavy_api_calls', quantity: 100 }
      ],
      accumulated_usage: [
        { delta: u === 0 ? 1 : 0, metric: 'storage', quantity: 1 },
        { delta: 1, metric: 'thousand_light_api_calls', quantity: u + 1 },
        { delta: 100, metric: 'heavy_api_calls', quantity: 100 * (u + 1) }
      ]
    });

    const oa = (o, ri, u) => [
      { metric: 'storage',
        quantity: ri < resourceInstances && u === 0 ?
        ri + 1 : resourceInstances },
      { metric: 'thousand_light_api_calls',
        quantity: ri + 1 + u * resourceInstances },
      { metric: 'heavy_api_calls',
        quantity: 100 * (ri + 1 + u * resourceInstances) }
    ];

    // 0, 0, 1, 2, 2, 2, 3, 4, 4, 4, 5, 6, 6, 6, 7, 8, 8, 8, ...........
    const copa = (ri) => Math.round(ri / 2 + (((ri % 2 === 0) ? 0 : 0.5) * ((ri / 2  - 0.5) % 2 === 0 ? -1 : 1)));

    const opa = (o, ri, u, p) => [
       { metric: 'storage',
         quantity: (ri - (p === 0 ? 2 : 0)) < resourceInstances && u === 0 ?
        copa(ri) : copa(resourceInstances + (p === 0 ? 1 : -1)) },
       { metric: 'thousand_light_api_calls',
        quantity: copa(ri) + u * copa(resourceInstances + (p === 0 ? 1 : -1)) },
       { metric: 'heavy_api_calls',
        quantity: 100 * (copa(ri) + u * copa(resourceInstances + (p === 0 ? 1 : -1))) }
     ];

    const opagg = (o, ri, u) => {
      if (ri < 2 && (resourceInstances <= 2 || u == 0)) {
        return [{
          plan_id: pid(0),
          aggregated_usage: opa(o, ri + 2, u, 0)
        }];
      }

      return [{
        plan_id: pid(0),
        aggregated_usage: opa(o, ri + 2, u, 0)
      }, {
        plan_id: pid(2),
        aggregated_usage: opa(o, ri, u, 1)
      }];
    };

    // 0, 1, 1, 2, 2, 3, 3, 4, 4,.....
    const csa = (ri) => Math.round(ri / 2);

    const sa = (o, ri, u, s) => [
      { metric: 'storage',
        quantity: (ri - (s === 0 ? 1 : 0) < resourceInstances && u === 0) ?
        csa(ri) : csa(resourceInstances - (s === 0 ? 0 : 1)) },
      { metric: 'thousand_light_api_calls',
        quantity: csa(ri) + u * csa(resourceInstances - (s === 0 ? 0 : 1)) },
      { metric: 'heavy_api_calls',
        quantity: 100 * (csa(ri) + u * csa(resourceInstances - (s === 0 ? 0 : 1))) }
    ];

    // 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, ......
    const cspa = (ri) => Math.round(ri / 4 - 0.25);

    const spa = (o, ri, u, s, p) => [
       { metric: 'storage',
         quantity: (ri - ((s === 0) ?  3 : 2)) < resourceInstances && u === 0 ?
        cspa(ri) : cspa(resourceInstances + ((s === 0) ? (p === 0 ? 2 : 0) : (p === 0 ? 1 : -1))) },
       { metric: 'thousand_light_api_calls',
        quantity: cspa(ri) + u * cspa(resourceInstances + ((s === 0) ? (p === 0 ? 2 : 0) : (p === 0 ? 1 : -1))) },
       { metric: 'heavy_api_calls',
        quantity: 100 * (cspa(ri) + u * cspa(resourceInstances + ((s === 0) ? (p === 0 ? 2 : 0) : (p === 0 ? 1 : -1)))) }
     ];

    const spagg = (o, ri, u, s) => {
      if (ri < (2 + s) && (resourceInstances <= (2 + s) || u == 0)) {
        return [{
          plan_id: pid(0),
          aggregated_usage: spa(o, ri + (s === 0 ? 3 : 2), u, s, 0)
        }];
      }

      return [{
        plan_id: pid(0),
        aggregated_usage: spa(o, ri + (s === 0 ? 3 : 2), u, s, 0)
      }, {
        plan_id: pid(2),
        aggregated_usage: spa(o, ri + (s === 0 ? 1 : 0), u, s, 1)
      }];
    };

    // 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, ......
    const cca = (ri) => ri % 8 < 6 ? 2 * Math.round(ri / 8 - 0.5) : 2 * Math.round(ri / 8 - 0.5) + 1;

    const ca = (o, ri, u, s, c) => [
      { metric: 'storage',
        quantity: (u === 0) ?
        cca(ri) : cca(resourceInstances - 1 + (s === 0 ? (c === 0 ? 6 : 2) : (c === 0 ? 5 : 1))) },
      { metric: 'thousand_light_api_calls',
        quantity: cca(ri) + u * cca(resourceInstances - 1 + (s === 0 ? (c === 0 ? 6 : 2) : (c === 0 ? 5 : 1))) },
      { metric: 'heavy_api_calls',
        quantity: 100 * (cca(ri) + u * cca(resourceInstances - 1  + (s === 0 ? (c === 0 ? 6 : 2) : (c === 0 ? 5 : 1)))) }
    ];

    // 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2,......
    const ccpa = (ri) => Math.round(ri / 8 - 0.50);

    const cpa = (o, ri, u, s, c, p) => [
       { metric: 'storage',
         quantity: (u === 0) ?
        ccpa(ri) : ccpa(resourceInstances - 1 + ((s === 0) ? ((c === 0) ? (p === 0 ? 8 : 6) : (p === 0 ? 4 : 2)) : ((c === 0) ? (p === 0 ? 7 : 5) : (p === 0 ? 3 : 1)))) },
       { metric: 'thousand_light_api_calls',
        quantity: ccpa(ri) + u * ccpa(resourceInstances - 1 + ((s === 0) ? ((c === 0) ? (p === 0 ? 8 : 6) : (p === 0 ? 4 : 2)) : ((c === 0) ? (p === 0 ? 7 : 5) : (p === 0 ? 3 : 1)))) },
       { metric: 'heavy_api_calls',
        quantity: 100 * (ccpa(ri) + u * ccpa(resourceInstances - 1 + ((s === 0) ? ((c === 0) ? (p === 0 ? 8 : 6) : (p === 0 ? 4 : 2)) : ((c === 0) ? (p === 0 ? 7 : 5) : (p === 0 ? 3 : 1))))) }
     ];

    const cpagg = (o, ri, u, s, c) => {
      if (ri < (c === 0 ? (2 + s) : (6 + s)) && (resourceInstances <= (c === 0 ? (2 + s) : (6 + s)) || u === 0)) {
        return [{
          plan_id: pid(0),
          aggregated_usage: cpa(o, ri + (s=== 0 ? (c === 0 ? 8 : 4) : (c === 0 ? 7 : 3)), u, s, c, 0)
        }];
      }

      return [{
        plan_id: pid(0),
        aggregated_usage: cpa(o, ri + (s=== 0 ? (c === 0 ? 8 : 4) : (c === 0 ? 7 : 3)), u, s, c, 0)
      }, {
        plan_id: pid(2),
        aggregated_usage: cpa(o, ri + (s=== 0 ? (c === 0 ? 6 : 2) : (c === 0 ? 5 : 1)), u, s, c, 1)
      }];
    };

    const cagg = (o, ri, u, s) => {
      if ( ri < (4 + s) && (resourceInstances <= (4 + s) || u === 0)) {
        return [{
          consumer_id: cid(o, s),
          resources: [{
            resource_id: 'object-storage',
            aggregated_usage: ca(o, ri + (s === 0 ? 6 : 5), u, s, 0),
            plans: cpagg(o, ri, u, s, 0)
          }]
        }];
      }

      return [{
        consumer_id: cid(o, s === 0 ? 0 : 1 ),
        resources: [{
          resource_id: 'object-storage',
          aggregated_usage: ca(o, ri + (s === 0 ? 6 : 5), u, s, 0),
          plans: cpagg(o, ri, u, s, 0)
        }]
      }, {
        consumer_id: cid(o, s === 0 ? 4 : 5),
        resources: [{
          resource_id: 'object-storage',
          aggregated_usage: ca(o, ri + (s === 0 ? 2 : 1), u, s, 1),
          plans: cpagg(o, ri, u, s, 1)
        }]
      }];
    };

    const sagg = (o, ri, u) => {
      if (ri === 0 && (resourceInstances === 1 || u === 0)) {
        return [{
          space_id: sid(o, 0),
          resources: [{
            resource_id: 'object-storage',
            aggregated_usage: sa(o, ri + 1, u, 0),
            plans: spagg(o, ri, u, 0)
          }],
          consumers: cagg(o, ri, u, 0)
        }];
      }
      
      return [{
        space_id: sid(o, 0),
        resources: [{
          resource_id: 'object-storage',
          aggregated_usage: sa(o, ri + 1, u, 0),
          plans: spagg(o, ri, u, 0)
        }],
        consumers: cagg(o, ri, u,  0)
      }, {
        space_id: sid(o, 1),
        resources: [{
          resource_id: 'object-storage',
          aggregated_usage: sa(o, ri, u, 1),
          plans: spagg(o, ri, u, 1)
        }],
        consumers: cagg(o, ri, u, 1)

      }];
    }

    // Aggregated usage for a given org, resource instance, usage #s
    const aggregatedTemplate = (o, ri, u) => ({
      accumulated_usage_id: uid(o, ri, u),
      organization_id: oid(o),
      start: day(end + u),
      end: eod(end + u),
      resources: [{
        resource_id: 'object-storage',
        aggregated_usage: oa(o, ri, u),
        plans: opagg(o, ri, u)
      }],
      spaces: sagg(o, ri, u)
    });

    // Post an accumulated usage doc, throttled to default concurrent requests
    const post = throttle((o, ri, u, cb) => {
      debug('Submit accumulated usage for org%d instance%d usage%d',
        o + 1, ri + 1, u + 1);

      console.log('accumulated: ', require('util').inspect(accumulatedTemplate(o, ri, u), { depth: null }));
      brequest.post('http://localhost::p/v1/metering/accumulated/usage',
        { p: 9200, body: accumulatedTemplate(o, ri, u) }, (err, val) => {
          expect(err).to.equal(undefined);
          expect(val.statusCode).to.equal(201);
          expect(val.headers.location).to.not.equal(undefined);

          debug('Aggregated accumulated usage for org%d instance%d' +
            ' usage%d, verifying it...', o + 1, ri + 1, u + 1);

          brequest.get(val.headers.location, undefined, (err, val) => {
            debug('Verify aggregated usage for org%d instance%d usage%d',
              o + 1, ri + 1, u + 1);

            expect(err).to.equal(undefined);
            expect(val.statusCode).to.equal(200);


            console.log('aggregated: ', require('util').inspect(val.body, { depth: null }));
            console.log('expected: ', require('util').inspect(aggregatedTemplate(o, ri, u), { depth: null }));

            expect(omit(val.body, ['id'])).to.deep
              .equal(aggregatedTemplate(o, ri, u));

            debug('Verified aggregated usage for org%d instance%d usage%d',
              o + 1, ri + 1, u + 1);

            cb();
          });
        });
    });

    // Post the requested number of accumulated usage docs
    const submit = (done) => {
      let posts = 0;
      const cb = () => {
        if(++posts === orgs * resourceInstances * usage) done();
      };

      // Submit usage for all orgs and resource instances
      map(range(usage), (u) => map(range(resourceInstances),
        (ri) => map(range(orgs), (o) => post(o, ri, u, cb))));
    };

    let retries = 0;
    const verifyRating = (done) => {
      try {
        debug('Verifying rating calls %d to equal to %d',
          rate.callCount, orgs * resourceInstances * usage);

        expect(rate.callCount).to.equal(orgs * resourceInstances * usage);
        done();
      }
      catch (e) {
        // If the comparison fails we'll be called again to retry
        // after 250 msec, but give up after 10 seconds
        if(++retries === 40) throw e;

        debug('Retry#%d', retries);
      }
    };

    // Wait for usage aggregator to start
    request.waitFor('http://localhost::p/batch',
      { p: 9200 }, (err, value) => {
        // Failed to ping usage aggregator before timing out
        if (err) throw err;

        // Submit accumulated usage and verify
        submit(() => {
          const i = setInterval(() =>
            verifyRating(() => done(clearInterval(i))), 250);
        });
      });
  });
});
