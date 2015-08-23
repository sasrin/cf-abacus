'use strict';

// Small utility that throttles calls to a Node function with callback to a
// maximum number of concurrent calls.

const _ = require('underscore');
const yieldable = require('abacus-yieldable');

const initial = _.initial;
const last = _.last;
const extend = _.extend;
const isFunction = _.isFunction;
const map = _.map;
const object = _.object;
const pairs = _.pairs;
const functions = _.functions;
const bind = _.bind;
const defaults = _.defaults;

// Setup debug log
const debug = require('abacus-debug')('abacus-throttle');

// Throttle the execution of an application function with callback to a
// maximum number of calls, defaults to 1000
const throttlefn = function(fn, o) {
  const fcb = yieldable.functioncb(fn);
  const opt = defaults(o ? o : {}, { name: fn.name || fn.fname, max: 1000 });
  const monitor = (() => {
    const metrics = {
      total: 0,
      running: 0,
      queued: 0,
      time: 0,
      failed: 0
    };

    setInterval(() => {
      console.log('average time %d - ', metrics.total ?
        metrics.time / (metrics.total - metrics.running - metrics.queued) : 0,
        opt.name, metrics);
    }, 1000);

    const m = (r, q, t, f) => {
      metrics.total = metrics.total + 1;
      metrics.running = r;
      metrics.queued = q;
      metrics.time = t ? metrics.time + t : metrics.time;
      metrics.failed = f ? metrics.failed + 1 : metrics.failed;
    };

    return extend(m, {
      failed: (r, q, t) => {
        metrics.running = r;
        metrics.queued = q;
        metrics.failed = metrics.failed + 1;
        metrics.time = t ? metrics.time + t : metrics.time;
      },
      completed: (r, q, t) => {
        metrics.running = r;
        metrics.queued = q;
        metrics.time = t ? metrics.time + t : metrics.time;
      }
    });
  })();

  let running = 0;
  let queue = [];

  const run = (args) => {
    // Call the application function
    const cb = last(args);
    const start = Date.now();
    try {
      return fcb.apply(null, initial(args).concat([function(err, val) {
        // Call the application callback
        try {
          cb(err, val);
        }
        finally {
          // Schedule the execution of the next queued call
          next(Date.now() - start);
        }
      }]));
    }
    catch(e) {
      // Schedule the execution of the next queued call
      next(Date.now() - start, true);
    }
  };

  // Schedule the execution of the next queued call
  const next = (time, failed) => {
    if(queue.length) {
      debug('Scheduling execution of queued function call, queue size %d',
        queue.length - 1);
      const args = queue.shift();
      process.nextTick(() => run(args));
    }
    else running = running - 1;

    if (failed) monitor.failed(running, queue.length, time);
    else monitor.completed(running, queue.length, time);
  };

  return function() {
    // Queue calls to the application function if we have reached the
    // max allowed concurrent calls
    if(running === opt.max) {
      debug(
        'Queuing function call, reached max concurrent calls %d, queue size %d',
        opt.max, queue.length + 1);
      monitor(running, queue.length + 1);
      return queue.push(arguments);
    }

    // Run the application function right away
    running = running + 1;
    monitor(running, queue.length);
    return run(arguments);
  };
};


// Bind a function to an object while retaining the function name
const nbind = (o, k) => extend(bind(o[k], o), {
    fname: (o.name || o.fname ? (o.name || o.fname) + '.' : '') + (o[k].name ||
      o[k].fname || k)
  });

// Convert an application function to a throttled function, if the given
// function is a module then convert all the module's exported functions as
// well.
const throttle = (fn, max) => extend(isFunction(fn) ? throttlefn(fn, max) : {},
  object(pairs(fn)), object(map(functions(fn),
    (k) => [k, throttlefn(nbind(fn, k), max)])));

// Export our public functions
module.exports = throttle;

