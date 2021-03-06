const logger = require('winston');
const stringify = require('json-stringify-pretty-compact');
const githubApi = require('./api/github');
const gitlabApi = require('./api/gitlab');
const handlebars = require('handlebars');
const versionsHelper = require('./helpers/versions');
const packageJson = require('./helpers/package-json');
const npmApi = require('./api/npm');
const prWorker = require('./workers/pr');
const branchWorker = require('./workers/branch');

let config;

module.exports = {
  processPackageFile,
  findUpgrades,
  processUpgradesSequentially,
  updateDependency,
};

// This function manages the queue per-package file
async function processPackageFile(repoName, packageFile, packageConfig) {
  // Initialize globals
  config = Object.assign({}, packageConfig);
  config.packageFile = packageFile;

  // Set API
  if (packageConfig.platform === 'github') {
    config.api = githubApi;
  }
  if (packageConfig.platform === 'gitlab') {
    config.api = gitlabApi;
  }

  logger.info(`Processing ${repoName} ${packageFile}`);

  const packageContent = await config.api.getFileJson(packageFile);
  // Check for renovate config inside the package.json
  if (packageContent.renovate) {
    logger.debug(`package.json>renovate config: ${stringify(packageContent.renovate)}`);
    Object.assign(config, packageContent.renovate, { repoConfigured: true });
  }
  // Now check if config is disabled
  if (config.enabled === false) {
    logger.info('Config is disabled. Skipping');
    return;
  }

  // Extract all dependencies from the package.json
  let dependencies = await packageJson.extractDependencies(packageContent, config.depTypes);
  // Filter out ignored dependencies
  dependencies =
    dependencies.filter(dependency => config.ignoreDeps.indexOf(dependency.depName) === -1);
  // Find all upgrades for remaining dependencies
  const upgrades = await findUpgrades(dependencies, config);
  // Process all upgrades sequentially
  await processUpgradesSequentially(config, upgrades);
  logger.info(`${repoName} ${packageFile} done`);
}

async function findUpgrades(dependencies, inputConfig) {
  const allUpgrades = [];
  // findDepUpgrades can add more than one upgrade to allUpgrades
  async function findDepUpgrades(dep) {
    const npmDependency = await npmApi.getDependency(dep.depName);
    const upgrades =
      await versionsHelper.determineUpgrades(npmDependency, dep.currentVersion, inputConfig);
    if (upgrades.length > 0) {
      logger.verbose(`${dep.depName}: Upgrades = ${JSON.stringify(upgrades)}`);
      upgrades.forEach((upgrade) => {
        allUpgrades.push(Object.assign({}, dep, upgrade));
      });
    } else {
      logger.verbose(`${dep.depName}: No upgrades required`);
    }
  }
  const promiseArray = dependencies.map(dep => findDepUpgrades(dep));
  // Use Promise.all to execute npm queries in parallel
  await Promise.all(promiseArray);
  // Return the upgrade array once all Promises are complete
  return allUpgrades;
}

async function processUpgradesSequentially(baseConfig, upgrades) {
  if (Object.keys(upgrades).length) {
    logger.verbose('Processing upgrades');
  } else {
    logger.verbose('No upgrades to process');
  }
  logger.verbose(`All upgrades: ${JSON.stringify(upgrades)}`);
  // We are processing each upgrade sequentially for two major reasons:
  // 1. Reduce chances of GitHub API rate limiting
  // 2. Edge case collision of branch name, e.g. dependency also listed as dev dependency
  for (const upgrade of upgrades) {
    await module.exports.updateDependency(Object.assign({}, baseConfig, upgrade));
  }
}

async function updateDependency(upgrade) {
  // Helpers for templating
  const params = Object.assign({}, upgrade);
  if (upgrade.upgradeType === 'pin') {
    params.isPin = true;
  } else if (upgrade.upgradeType === 'major') {
    params.isMajor = true;
  } else if (upgrade.upgradeType === 'minor') {
    params.isMinor = true;
  }
  // Use templates to generate strings
  const branchName = handlebars.compile(params.branchName)(params);
  const prTitle = handlebars.compile(params.prTitle)(params);

  try {
    if (!params.recreateClosed && await params.api.checkForClosedPr(branchName, prTitle)) {
      logger.verbose(`Skipping ${params.depName} upgrade as matching closed PR already existed`);
      return;
    }
    await branchWorker.ensureBranch(params);
    await prWorker.ensurePr(params);
  } catch (error) {
    logger.error(`Error updating dependency ${params.depName}: ${error}`);
    // Don't throw here - we don't want to stop the other renovations
  }
}
