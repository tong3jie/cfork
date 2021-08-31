'use strict';

var cluster = require('cluster');
var os = require('os');
var util = require('util');
var utility = require('utility');
const fs = require('fs');
const path = require('path');

var defer = global.setImmediate || process.nextTick;

module.exports = fork;

/**
 * cluster fork
 *
 * @param {Object} [options]
 *   - {String} exec       exec file path
 *   - {Array} [args]      exec arguments
 *   - {Array} [slaves]    slave processes
 *   - {Boolean} [silent]  whether or not to send output to parent's stdio, default is `false`
 *   - {Number} [count]    worker num, default is `os.cpus().length`
 *   - {Boolean} [refork]  refork when disconnect and unexpected exit, default is `true`
 *   - {Boolean} [autoCoverage] auto fork with istanbul when `running_under_istanbul` env set, default is `false`
 *   - {Boolean} [windowsHide] Hide the forked processes console window that would normally be created on Windows systems. Default: false.
 * @return {Cluster}
 */

function fork(options) {
  if (cluster.isWorker) {
    return;
  }

  options = options || {};
  var count = options.envs || options.count || os.cpus().length;
  var refork = options.refork !== false;
  var limit = options.limit || 60;
  var duration = options.duration || 60000; // 1 min
  var reforks = [];
  const workerManger = new Map();
  var newWorker;

  if (options.exec) {
    var opts = {
      exec: options.exec,
    };

    if (options.execArgv !== undefined) {
      opts.execArgv = options.execArgv;
    }

    if (options.args !== undefined) {
      opts.args = options.args;
    }
    if (options.silent !== undefined) {
      opts.silent = options.silent;
    }
    if (options.windowsHide !== undefined) {
      opts.windowsHide = options.windowsHide;
    }

    // https://github.com/gotwarlost/istanbul#multiple-process-usage
    // Multiple Process under istanbul
    if (options.autoCoverage && process.env.running_under_istanbul) {
      // use coverage for forked process
      // disabled reporting and output for child process
      // enable pid in child process coverage filename
      var args = ['cover', '--report', 'none', '--print', 'none', '--include-pid', opts.exec];
      if (opts.args && opts.args.length > 0) {
        args.push('--');
        args = args.concat(opts.args);
      }

      opts.exec = './node_modules/.bin/istanbul';
      opts.args = args;
    }

    cluster.setupMaster(opts);
  }

  var disconnects = {};
  var disconnectCount = 0;
  var unexpectedCount = 0;
  function checkWorker() {
    setInterval(() => {
      const workerSize = workerManger.size;
      if (options.model === 'file') {
        options.envs = JSON.parse(fs.readFileSync(options.configFile, 'utf8')).envs;
      }

      if (workerSize < (options.envs.length || count)) {
        options.envs
          .filter(item => workerManger.has(item))
          .forEach(item => {
            newWorker = forkWorker(null, item);
            newWorker._clusterSettings = cluster.settings;
          });
      }

      if (workerSize > (options.envs.length || count)) {
        for (const key of workerManger.keys()) {
          if (!options.envs.includes(key)) {
            const worker = workerManger.get(key);
            worker.disableRefork = true;
            worker.kill('cancel');
            workerManger.delete(key);
          }
        }
      }
      checkWorker();
    }, 60000);
  }

  checkWorker();

  cluster.on('fork', worker => {
    workerManger.set(JSON.stringify(worker.env) || worker.process.pid, worker);
  });
  cluster.on('disconnect', function (worker) {
    workerManger.delete(worker.process.pid);
    var log = console[worker.disableRefork ? 'info' : 'error'];
    disconnectCount++;
    var isDead = worker.isDead && worker.isDead();
    var propertyName = worker.hasOwnProperty('exitedAfterDisconnect') ? 'exitedAfterDisconnect' : 'suicide';
    log('[%s] [cfork:master:%s] worker:%s disconnect (%s: %s, state: %s, isDead: %s, worker.disableRefork: %s)', utility.logDate(), process.pid, worker.process.pid, propertyName, worker[propertyName], worker.state, isDead, worker.disableRefork);
    if (isDead) {
      // worker has terminated before disconnect
      log("[%s] [cfork:master:%s] don't fork, because worker:%s exit event emit before disconnect", utility.logDate(), process.pid, worker.process.pid);
      return;
    }
    if (worker.disableRefork) {
      // worker has terminated by master, like egg-cluster master will set disableRefork to true
      log("[%s] [cfork:master:%s] don't fork, because worker:%s will be kill soon", utility.logDate(), process.pid, worker.process.pid);
      return;
    }

    disconnects[worker.process.pid] = utility.logDate();
    if (allow()) {
      newWorker = forkWorker(worker._clusterSettings, worker.env);
      newWorker._clusterSettings = worker._clusterSettings;
      log('[%s] [cfork:master:%s] new worker:%s fork (state: %s)', utility.logDate(), process.pid, newWorker.process.pid, newWorker.state);
    } else {
      log("[%s] [cfork:master:%s] don't fork new work (refork: %s)", utility.logDate(), process.pid, refork);
    }
  });

  cluster.on('exit', function (worker, code, signal) {
    workerManger.delete(worker.process.pid);
    var log = console[worker.disableRefork ? 'info' : 'error'];
    var isExpected = !!disconnects[worker.process.pid];
    var isDead = worker.isDead && worker.isDead();
    var propertyName = worker.hasOwnProperty('exitedAfterDisconnect') ? 'exitedAfterDisconnect' : 'suicide';
    log('[%s] [cfork:master:%s] worker:%s exit (code: %s, %s: %s, state: %s, isDead: %s, isExpected: %s, worker.disableRefork: %s)', utility.logDate(), process.pid, worker.process.pid, code, propertyName, worker[propertyName], worker.state, isDead, isExpected, worker.disableRefork);
    if (isExpected) {
      delete disconnects[worker.process.pid];
      // worker disconnect first, exit expected
      return;
    }
    if (worker.disableRefork) {
      // worker is killed by master
      return;
    }

    unexpectedCount++;
    if (allow()) {
      newWorker = forkWorker(worker._clusterSettings, worker.env);
      newWorker._clusterSettings = worker._clusterSettings;
      log('[%s] [cfork:master:%s] new worker:%s fork (state: %s)', utility.logDate(), process.pid, newWorker.process.pid, newWorker.state);
    } else {
      log("[%s] [cfork:master:%s] don't fork new work (refork: %s)", utility.logDate(), process.pid, refork);
    }
    cluster.emit('unexpectedExit', worker, code, signal);
  });

  // defer to set the listeners
  // so you can listen this by your own
  defer(function () {
    if (process.listeners('uncaughtException').length === 0) {
      process.on('uncaughtException', onerror);
    }
    if (cluster.listeners('unexpectedExit').length === 0) {
      cluster.on('unexpectedExit', onUnexpected);
    }
    if (cluster.listeners('reachReforkLimit').length === 0) {
      cluster.on('reachReforkLimit', onReachReforkLimit);
    }
  });
  if (options.model === 'both' || !options.model) {
    for (let i = 0; i < count; i++) {
      newWorker = forkWorker();
      newWorker._clusterSettings = cluster.settings;
    }
  } else if (options.model === 'each') {
    options.envs.forEach(env => {
      newWorker = forkWorker(null, env);
      newWorker._clusterSettings = cluster.settings;
    });
  } else if (options.model === 'file') {
    options.envs = fs.readFileSync(options.configFile, 'utf8');
    options.envs.forEach(env => {
      newWorker = forkWorker(null, env);
      newWorker._clusterSettings = cluster.settings;
    });
  }

  // fork slaves after workers are forked
  if (options.slaves) {
    var slaves = Array.isArray(options.slaves) ? options.slaves : [options.slaves];
    slaves.map(normalizeSlaveConfig).forEach(function (settings) {
      if (settings) {
        newWorker = forkWorker(settings);
        newWorker._clusterSettings = settings;
      }
    });
  }

  return cluster;

  /**
   * allow refork
   */
  function allow() {
    if (!refork) {
      return false;
    }

    var times = reforks.push(Date.now());

    if (times > limit) {
      reforks.shift();
    }

    var span = reforks[reforks.length - 1] - reforks[0];
    var canFork = reforks.length < limit || span > duration;

    if (!canFork) {
      cluster.emit('reachReforkLimit');
    }

    return canFork;
  }

  /**
   * uncaughtException default handler
   */

  function onerror(err) {
    if (!err) {
      return;
    }
    console.error('[%s] [cfork:master:%s] master uncaughtException: %s', utility.logDate(), process.pid, err.stack);
    console.error(err);
    console.error('(total %d disconnect, %d unexpected exit)', disconnectCount, unexpectedCount);
  }

  /**
   * unexpectedExit default handler
   */

  function onUnexpected(worker, code, signal) {
    var exitCode = worker.process.exitCode;
    var propertyName = worker.hasOwnProperty('exitedAfterDisconnect') ? 'exitedAfterDisconnect' : 'suicide';
    var err = new Error(util.format('worker:%s died unexpected (code: %s, signal: %s, %s: %s, state: %s)', worker.process.pid, exitCode, signal, propertyName, worker[propertyName], worker.state));
    err.name = 'WorkerDiedUnexpectedError';

    console.error('[%s] [cfork:master:%s] (total %d disconnect, %d unexpected exit) %s', utility.logDate(), process.pid, disconnectCount, unexpectedCount, err.stack);
  }

  /**
   * reachReforkLimit default handler
   */

  function onReachReforkLimit() {
    console.error('[%s] [cfork:master:%s] worker died too fast (total %d disconnect, %d unexpected exit)', utility.logDate(), process.pid, disconnectCount, unexpectedCount);
  }

  /**
   * normalize slave config
   */
  function normalizeSlaveConfig(opt) {
    // exec path
    if (typeof opt === 'string') {
      opt = { exec: opt };
    }
    if (!opt.exec) {
      return null;
    } else {
      return opt;
    }
  }

  /**
   * fork worker with certain settings
   */
  function forkWorker(settings, env) {
    if (settings) {
      cluster.settings = settings;
      cluster.setupMaster();
    }
    const worker = cluster.fork(env);
    worker.env = env;
    this.workerManger.set(JSON.stringify(env) || newWorker.process.pid, newWorker);

    return worker;
  }
}
