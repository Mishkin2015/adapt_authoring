/**
* TODO:
* - doesUpdateExist
* - merge with frameworkHelpers
*/

var _ = require('underscore');
var async = require('async');
var chalk = require('chalk');
var exec = require('child_process').exec;
var fs = require('fs-extra');
var path = require('path');
var request = require('request');
var semver = require('semver');

var configuration = require('./lib/configuration');

var SILENT = false;

var DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2272.118 Safari/537.36';

var DEFAULT_SERVER_REPO = 'https://github.com/adaptlearning/adapt_authoring.git';
var DEFAULT_FRAMEWORK_REPO = 'https://github.com/adaptlearning/adapt_framework.git';
var REMOTE_NAME = 'adapt-origin';

var exports = module.exports = {
  getInstalledServerVersion,
  getLatestServerVersion,
  getInstalledFrameworkVersion,
  getLatestFrameworkVersion,
  getInstalledVersions,
  getLatestVersions,
  getUpdateData,
  installFramework,
  updateFramework,
  updateFrameworkPlugins,
  updateAuthoring
};

function getInstalledServerVersion(callback) {
  try {
    var pkg = fs.readJSONSync('package.json');
    callback(null, pkg.version);
  } catch(e) {
    callback(`Cannot determine authoring tool version, ${e}`);
  }
}

function getLatestServerVersion(callback) {
  checkLatestAdaptRepoVersion('adapt_authoring', callback);
}

function getInstalledFrameworkVersion(callback) {
  try {
    var pkg = fs.readJSONSync(path.join(getFrameworkRoot(), 'package.json'));
    callback(null, pkg.version);
  } catch(e) {
    return callback(`Cannot determine framework version, ${e}`);
  }
}

function getLatestFrameworkVersion(callback) {
  checkLatestAdaptRepoVersion('adapt_framework', callback);
}

function getInstalledVersions(callback) {
  async.parallel([
    exports.getInstalledServerVersion,
    exports.getInstalledFrameworkVersion
  ], function(error, results) {
    callback(error, {
      adapt_authoring: results[0],
      adapt_framework: results[1]
    });
  });
}

function getLatestVersions(callback) {
  async.parallel([
    exports.getLatestServerVersion,
    exports.getLatestFrameworkVersion
  ], function(error, results) {
    callback(error, {
      adapt_authoring: results[0],
      adapt_framework: results[1]
    });
  });
}

function getUpdateData(callback) {
  async.parallel([
    exports.getInstalledVersions,
    exports.getLatestVersions
  ], function(error, results) {
    var updateData = {};
    if(semver.lt(results[0].adapt_authoring, results[1].adapt_authoring)) {
      updateData.adapt_authoring = results[1].adapt_authoring;
    }
    if(semver.lt(results[0].adapt_framework, results[1].adapt_framework)) {
      updateData.adapt_framework = results[1].adapt_framework;
    }
    if(Object.keys(updateData).length === 0) {
      updateData = undefined;
    }
    callback(error, updateData);
  });
}

function getFrameworkRoot() {
  return path.join(configuration.serverRoot, 'temp', configuration.getConfig('masterTenantID'), 'adapt_framework');
}

function checkLatestAdaptRepoVersion(repoName, callback) {
  request({
    headers: { 'User-Agent': DEFAULT_USER_AGENT },
    uri: `https://api.github.com/repos/adaptlearning/${repoName}/releases/latest`,
    method: 'GET'
  }, function(error, response, body) {
    if (response.statusCode !== 200) {
      error = 'GitubAPI did not respond with a 200 status code';
    }
    if (error) {
      return callback(`Couldn't check latest version of ${repoName}, ${error}`);
    }
    try {
      var version = JSON.parse(body).tag_name;
    } catch(e) {
      return callback(`Couldn't check latest version of ${repoName}, ${e}`);
    }
    callback(null, version);
  });
}

/**
* Clones/updates the temp/ framework folder
* Accepts the following options: {
*   repository: URL to pull framework from,
*   revision: in the format tags/[TAG] or remote/[BRANCH],
*   force: forces a clone regardless of whether we have an existing clone,
* }
*/
function installFramework(opts, callback) {
  if(arguments.length !== 2 || !opts.revision) {
    return callback('Cannot install framework, invalid options passed');
  }
  if(!opts.repository) {
    opts.repository = DEFAULT_FRAMEWORK_REPO;
  }
  var func = fs.existsSync(getFrameworkRoot()) && !opts.force ?  fetchFramework : cloneFramework;
  func.call(this, opts.repository, function(error) {
    if (error) {
      return callback(error);
    }
    updateFramework(opts, callback);
  });
}

function cloneFramework(repoURL, callback) {
  console.log('Cloning the Adapt framework');
  execCommand(`git clone ${repoURL} --origin ${REMOTE_NAME}`, {
    cwd: getFrameworkRoot()
  }, callback);
}

function fetchFramework(repoURL, callback) {
  console.log('Fetching the latest framework data');
  execCommand(`git remote set-url ${REMOTE_NAME} ${configuration.getConfig('frameworkRepository')} && git fetch ${REMOTE_NAME}`, {
    cwd: getFrameworkRoot()
  }, callback);
}

function updateFramework(opts, callback) {
  if(!opts.revision) {
    return callback('Cannot update framework, revision not specified');
  }
  execCommand(`git reset --hard ${opts.revision} && npm install`, {
    cwd: getFrameworkRoot()
  }, function(error) {
    if (error) {
      return callback(error);
    }
    async.parallel([
      purgeCourseFolder,
      updateFrameworkPlugins
    ], callback);
  });
}

/**
* Uses adapt.json to install the latest plugin versions
*/
function updateFrameworkPlugins(callback) {
  fs.readJSON(path.join(getFrameworkRoot(), 'adapt.json'), function(error, json) {
    if (error) {
      return callback(error);
    }
    var plugins = Object.keys(json.dependencies);
    async.eachSeries(plugins, function(plugin, pluginCallback) {
      if(json.dependencies[plugin] === '*') {
        app.bowermanager.installLatestCompatibleVersion(plugin, pluginCallback);
      } else {
        app.bowermanager.installPlugin(plugin, json.dependencies[plugin], pluginCallback);
      }
    }, callback);
  });
}

/**
* This isn't used by the authoring tool
*/
function purgeCourseFolder(callback) {
  fs.remove(path.join(getFrameworkRoot(), 'src', 'course'), callback);
}

function updateAuthoring(opts, callback) {
  if(!opts.revision) {
    return callback('Cannot update server, revision not specified');
  }
  if(!opts.repository) {
    opts.repository = DEFAULT_SERVER_REPO;
  }
  log(`Updating server to ${opts.revision}`);
  async.series([
    function fetchLatest(cb) {
      log('Fetching latest changes');
      execCommand(`git remote set-url ${REMOTE_NAME} ${opts.repository} && git fetch ${REMOTE_NAME}`, cb);
    },
    function pullLatest(cb) {
      log('Pulling latest changes');
      execCommand(`git reset --hard ${opts.revision}`, cb);
    },
    function installDeps(cb) {
      log(`Installing server dependencies`);
      exec('npm install', cb);
    },
    function rebuildApp(cb) {
      log('Building front-end');
      execCommand('grunt build:prod', cb);
    },
    function updateVersion(cb) {
      log(`Server has been updated successfully`);
      cb();
    }
  ], callback);
}

function execCommand(cmd, opts, callback) {
  if(arguments.length === 2) {
    callback = opts;
    opts = {};
  }
  var child = exec(cmd, _.extend({ stdio: [0, 'pipe', 'pipe'] }, opts));
  child.stdout.on('data', log);
  child.stderr.on('data', logError);
  child.on('exit', callback);
}

function log(msg) {
  if(!SILENT) console.log(msg);
}

function logHeader(msg) {
  if(!SILENT) console.log(chalk.underline(`\n${msg}`));
}

function logError(msg) {
  if(!SILENT) console.error('ERROR:', msg);
}