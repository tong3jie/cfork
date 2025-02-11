import * as os from 'os';
import * as process from 'process';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { join } from 'path';
import * as winston from 'winston';

const cluster = require('cluster');

const baseDir = process.cwd();
const defer = global.setImmediate || process.nextTick;

const infoStream = fs.createWriteStream(join(baseDir, 'logs', 'ctdOut.log'), {
  flags: 'a',
});
const errorStream = fs.createWriteStream(join(baseDir, 'logs', 'ctdErr.log'), {
  flags: 'a',
});
const Logger = winston.createLogger({
  format: winston.format.json(),
  transports: [
    new winston.transports.Stream({
      stream: infoStream,
      level: 'info',
    }),
    new winston.transports.Stream({
      stream: errorStream,
      level: 'error',
    }),
  ],
});

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
 *   - {Boolean} [windowsHide] Hide the forked processes Logger window that would normally be created on Windows systems. Default: false.
 * @return {Cluster}
 */
interface Option {
  exec: string;
  model?: 'fork' | 'cluster';
  clusterModel?: 'both' | 'each';
  envs?: { [key: string]: any };
  limit?: number;
  args?: string[];
  count?: number;
  autoCoverage?: boolean;
  windowsHide?: boolean;
  duration?: number;
}
class Tfork {
  readonly option: any;

  options: Option;

  workerManger = new Map();

  unexpectedCount = 0; // unexpected的次数

  reforks: any[];

  exitCallback: (worker?: any, code?: number, signal?: string) => void;

  constructor(
    option: Option | string,
    exitCallback?: (worker?: any, code?: number, signal?: string) => void
  ) {
    this.option = option;
    this.exitCallback = exitCallback;
    if (typeof option === 'string') {
      this.options = JSON.parse(fs.readFileSync(option, 'utf8'));
      // 监视文件修改情况

      fs.watchFile(option, () => {
        Logger.info(`configFile is update`);
        this.checkWorker();
      });
    } else if (typeof option === 'object') {
      this.options = { ...option };
      this.options = {
        ...this.options,
        count: this.options?.envs?.length || this.options.count || os.cpus().length,
        duration: this.options.duration || 60,
      };
    }

    this.reforks = [];

    cluster.setupMaster(this.options);

    this.autoCheck();
  }

  start() {
    if (cluster.isWorker) {
      return;
    }

    if (this.options?.clusterModel === 'both') {
      for (let i = 0; i < this.options.count; i += 1) {
        const newWorker = this.forkWorker();
        newWorker._clusterSettings = cluster.settings;
      }
    } else if (this.options?.clusterModel === 'each') {
      this.options?.envs?.forEach(env => {
        const newWorker = this.forkWorker(null, env);
        newWorker._clusterSettings = cluster.settings;
      });
    } else {
      for (let i = 0; i < this.options.count; i += 1) {
        const newWorker = this.forkWorker();
        newWorker._clusterSettings = cluster.settings;
      }
    }

    cluster.on('disconnect', worker => {
      Logger.info(
        `[${new Date()}] [cfork:master:${process.pid}] worker:${worker.process.pid} disconnect`
      );
      if (worker.isDead()) {
        Logger.info(
          `[${new Date()}] [cfork:master:${process.pid}] don't fork, because worker:${
            worker.process.pid
          } exit event emit before disconnect`
        );
        return;
      }

      if (worker.disableRefork) {
        Logger.info(
          `[${new Date()}] [cfork:master:${process.pid}] don't fork, because worker:${
            worker.process.pid
          } will be kill soon`
        );
      }
      if (this.allow()) {
        const newWorker = this.forkWorker(worker._clusterSettings, worker.env);
        newWorker._clusterSettings = worker._clusterSettings;
        Logger.info(
          `[${new Date()}] [cfork:master:${process.pid}] new worker:${
            worker.process.pid
          } fork (state: ${newWorker.state})`
        );
      } else {
        Logger.info(`[${new Date()}] [cfork:master:${process.pid}] don't fork new work `);
      }
    });

    cluster.on('exit', (worker, code, signal) => {
      Logger.info(
        `[${new Date()}] [cfork:master:${process.pid}] worker:${
          worker.process.pid
        } exit (code: ${code})`
      );

      if (worker.disableRefork) {
        // worker is killed by master
        return;
      }

      this.unexpectedCount += 1;
      if (this.allow()) {
        const newWorker = this.forkWorker(worker._clusterSettings, worker.env);
        newWorker._clusterSettings = worker._clusterSettings;
        Logger.info(
          `[${new Date()}] [cfork:master:${process.pid}] new worker:${
            worker.process.pid
          } fork (state: ${newWorker.state})`
        );
      } else {
        if (this.exitCallback) this.exitCallback();
        Logger.info(`[${new Date()}] [cfork:master:${process.pid}] don't fork new work `);
      }
      cluster.emit('unexpectedExit', worker, code, signal);
    });

    this.defer();
    return cluster;
  }

  // 返回所有worker
  getWorkers(): Map<string, any> {
    return this.workerManger;
  }

  // 检查配置文件，并创建或者删除进程
  checkWorker() {
    const workerSize = this.workerManger.size;
    if (typeof this.option === 'string') {
      this.options = JSON.parse(fs.readFileSync(this.option, 'utf8'));
    }

    cluster.setupMaster(this.options);

    if (this.option?.envs && Array.isArray(this.option?.envs)) {
      // 检查是否有新配置，需要增加进程
      this.options?.envs
        .filter(item => !this.workerManger.has(this.MD5(JSON.stringify(item))))
        .forEach(item => {
          cluster.emit(
            'checkWorker',
            `checkWorker will fork new worker,because workerSize ${workerSize} !!!less!!! than ${
              this.options?.envs?.length || this.options.count
            } ,env is ${JSON.stringify(item)}`
          );
          const newWorker = this.forkWorker(null, item);
          newWorker._clusterSettings = cluster.settings;
        });

      // 检查是否有行配置，需要减少进程
      const envsMD5 = this.options?.envs.map(item => this.MD5(JSON.stringify(item)));
      for (const key of this.workerManger.keys()) {
        if (!envsMD5.includes(key)) {
          const worker = this.workerManger.get(key);
          cluster.emit(
            'checkWorker',
            `checkWorker will kill worker,because workerSize ${workerSize} !!!more!!! than ${
              this.options?.envs.length || this.options.count
            } ,env is ${key},pid is ${worker.process.pid}`
          );
          worker.disableRefork = true;
          process.kill(worker.process.pid, 'SIGKILL');
          if (this.exitCallback) this.exitCallback();
          this.workerManger.delete(key);
        }
      }
    }
  }

  // 自动检测程配置文件，作为监视文件的托底
  autoCheck() {
    setInterval(() => {
      if (typeof this.option === 'string') {
        this.options = JSON.parse(fs.readFileSync(this.option, 'utf8'));
      }
      this.checkWorker();
    }, 60000);
  }

  /**
   * fork worker with certain settings
   */
  forkWorker(settings?, env?) {
    if (settings) {
      cluster.settings = settings;
      cluster.setupMaster({ silent: true });
    }
    const worker = cluster.fork(env);
    worker.env = env;
    worker.disableRefork = false;
    this.workerManger.set(env ? this.MD5(JSON.stringify(env)) : worker.process.pid, worker);
    return worker;
  }

  MD5(str: string) {
    return crypto.createHash('md5').update(str).digest('hex').toString();
  }

  defer() {
    defer(() => {
      if (process.listeners('uncaughtException').length === 0) {
        process.on('uncaughtException', err => {
          if (!err) {
            return;
          }
          Logger.error(
            `[${new Date()}] [cfork:master:${process.pid}] master uncaughtException: ${err.stack}`
          );
          Logger.error(err);
        });
      }
      if (cluster.listeners('unexpectedExit').length === 0) {
        cluster.on('unexpectedExit', (worker, code, signal) => {
          const err = new Error(
            `worker:${worker.process.pid} died unexpected (code: ${code}, signal: ${signal}, exitedAfterDisconnect: ${worker.exitedAfterDisconnect}, state: ${worker.state})`
          );
          err.name = 'WorkerDiedUnexpectedError';

          Logger.error(`[${new Date()}] [cfork:master:${process.pid}]  ${err.stack}`);
        });
      }
      if (cluster.listeners('reachReforkLimit').length === 0) {
        cluster.on('reachReforkLimit', () => {
          Logger.error(`[${new Date()}] [cfork:master:${process.pid}] worker died too fast  `);
        });
      }
    });
  }

  allow() {
    this.reforks.push(Date.now());

    // 时间差
    const span = this.reforks[this.reforks.length - 1] - this.reforks[0];
    const canFork = span > this.options.duration;

    if (!canFork) {
      cluster.emit('reachReforkLimit');
    }

    return canFork;
  }
}

export { Tfork };
