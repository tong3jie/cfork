<!--
 * @author: juju
 * @Date: 2021-08-30 22:39:10
 * @LastEditTime: 2021-09-01 18:17:12
 * @LastEditors: juju
 * @Description: 
 * @FilePath: \cfork\README.md
-->
tfork
=======

this project was fork the module of cfork.

we found cfork cann't fork different worker by env

cluster fork and restart easy way.

* Easy fork with worker file path
* Handle worker restart, even it was exit unexpected.
* Auto error log process `uncaughtException` event
* set `envs`, worker count is length of envs ,and every worker's env different. if worker was exit because of configFile, will not refork.

## Install

```bash
$ npm install tfork --save
```

## Usage

### Example

```js
const tfork = require('tfork');
const util = require('util');

tfork({
  exec: '/your/app/worker.js',
  count: require('os').cpus().length,
}, callback())
// or tfork('./config.json')
// callback() is optional
.start()
.on('fork', worker => {
  console.warn(`new worker was started`)
.on('disconnect', worker => {
  console.warn(`worker will  disconnect`);
})
.on('exit', (worker, code, signal) => {
  
  console.error(`${worker.process.pid}`)
  })


.on('unexpectedExit', (worker, code, signal) => {
  // logger what you want
})

// emit when reach refork times limit
.on('reachReforkLimit', () => {
  // do what you want
}).getWorkers()
// return all workers

// if you do not listen to this event
// cfork will listen it and output the error message to stderr
process.on('uncaughtException', err => {
  // do what you want
});
```

### Options

**options can be an object or a file(config path), you can edit content of your config file  and it will work  1 minute  later**

- **exec** : exec file path
- **args** : exec arguments
- **count** : fork worker nums, default is `os.cpus().length`
- **duration**: default is `60000`, one minute (so, the `refork times` < `limit / duration`)
- **env**: attach some environment variable key-value pairs to the worker / slave process, default to an empty object.
- **evns**: if you want every worker has different env config ,you can set this field, default is [].example, envs:[{name:1},{name:2}]
- **model**: 
  - 'both':every worker has same evn config
  - 'each':every worker has different evn config
- **callback**: when the worker was exit ,`callback` will be wake up 
## License

```
(The MIT License)

Copyright (c) 2014 - 2017 node-modules and other contributors

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
