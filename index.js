const dockerCompose = require('docker-compose');
const dockerComposeFile = require('./lib/docker-compose-file');
const sam = require('./lib/sam');
const redis = require('redis');
const { promisify } = require('util');
const constants = require('./lib/constants');
const utils = require('./lib/utils');
const AWS = require('aws-sdk');
const AWS_REGION = 'eu-west-1';
const crypto = require('crypto');
const STEP_FUNCTION_NAME = 'testStepFunction';
const debug = require('debug')('step-functions-tester');
class TestRunner {
  async setUp(options = {}) {
    this.options = options;
    const { stop: stopSam } = await sam.runSam();
    this.stopSam = stopSam;
    const { endpoint: stepFunctionEndpoint } = await setUpStepFunctions(
      options
    );

    this.stepFunctionClient = new AWS.StepFunctions({
      endpoint: stepFunctionEndpoint,
      region: AWS_REGION,
      credentials: new AWS.Credentials({
        accessKeyId: 'dummy',
        secretAccessKey: 'dummy',
      }),
    });

    const redisClient = redis.createClient();
    this.redisClient = redisClient;

    await new Promise(function (resolve) {
      redisClient.on('connect', resolve);
      // TODO probably on error reject
    });
    const promisifiedGet = promisify(this.redisClient.get).bind(
      this.redisClient
    );
    this.redisGet = async function (key) {
      const raw = await promisifiedGet(key);
      return JSON.parse(raw);
    };

    const promisifiedSet = promisify(this.redisClient.set).bind(
      this.redisClient
    );

    this.redisSet = async function (key, obj) {
      return promisifiedSet(key, JSON.stringify(obj));
    };

    const lambdaClient = new AWS.Lambda({
      endpoint: `http://localhost:${constants.DEFAULT_LABMDA_PORT}`, // TODO accept port as parameter
      region: AWS_REGION,
      credentials: new AWS.Credentials({
        accessKeyId: 'dummy',
        secretAccessKey: 'dummy',
      }),
    });
    // Call without functionName in parameter so it does not save
    await lambdaClient
      .invoke({
        FunctionName: constants.LAMBDA_NAME,
      })
      .promise();
  }

  getStepFunctionArn() {
    return `arn:aws:states:us-east-1:123456789012:stateMachine:${this.stepFunctionName}`;
  }

  async run(
    callStubs,
    stepFunctionDefinition,
    stepFunctionInput,
    options = {
      executionTimeout: constants.DEFAULT_EXECUTION_TIMEOUT,
      executionInterval: constants.DEFAULT_EXECUTION_INTERVAL,
    }
  ) {
    const executionTimeout = options.executionTimeout;
    const executionInterval = options.executionInterval;
    const stepFunctionClient = this.stepFunctionClient;
    for (const functionKey in callStubs) {
      // TODO use key
      const functionExecutions = callStubs[functionKey];
      await this.redisSet(`stubs:${functionKey}`, functionExecutions);
    }
    const fixedDefinition = utils.fixStepFunction(stepFunctionDefinition);

    // Deletion takes long time, better to create random names and let the step function be deleted at its time
    this.stepFunctionName = `${STEP_FUNCTION_NAME}-${crypto
      .randomBytes(5)
      .toString('hex')}`;
    await stepFunctionClient
      .createStateMachine({
        definition: JSON.stringify(fixedDefinition),
        name: this.stepFunctionName,
        roleArn: 'arn:aws:iam::012345678901:role/DummyRole',
      })
      .promise();

    const execution = await stepFunctionClient
      .startExecution({
        stateMachineArn: this.getStepFunctionArn(),
        name: new Date().getTime().toString(),
        input: JSON.stringify(stepFunctionInput),
      })
      .promise();

    let stillRunning = true;
    let executionError = null;
    const timeout = setTimeout(function () {
      stillRunning = false;
      executionError = new Error(
        'Step function not finished within requested timeout'
      );
    }, executionTimeout);

    let stepFunctionResult;
    while (stillRunning) {
      stepFunctionResult = await stepFunctionClient
        .describeExecution({ executionArn: execution.executionArn })
        .promise();
      if (stepFunctionResult.status === 'RUNNING') {
        await utils.waitFor(executionInterval);
      } else {
        stillRunning = false;
      }
    }

    if (executionError !== null) {
      throw executionError;
    }

    clearInterval(timeout);

    const executionHistory = await stepFunctionClient
      .getExecutionHistory({ executionArn: execution.executionArn })
      .promise();

    const executions = await this.redisGet('executions');

    return {
      executions,
      stepFunctionExecution: stepFunctionResult,
      stepFunctionHistory: executionHistory,
    };
  }

  async cleanUp() {
    const redisClient = this.redisClient;
    const keys = await new Promise(function (resolve, reject) {
      redisClient.keys('*', function (err, keys) {
        if (err) {
          return reject(err);
        }
        resolve(keys);
      });
    });
    const del = promisify(redisClient.del).bind(redisClient);
    for (const key of keys) {
      await del(key);
    }

    const { executions } = await this.stepFunctionClient
      .listExecutions({ stateMachineArn: this.getStepFunctionArn() })
      .promise();
    for (const execution of executions) {
      await this.stepFunctionClient
        .stopExecution({ executionArn: execution.executionArn })
        .promise();
    }
    await this.stepFunctionClient
      .deleteStateMachine({ stateMachineArn: this.getStepFunctionArn() })
      .promise();
  }

  async tearDown() {
    this.redisClient.end(false);
    await this.stopSam();
    const dockerComposeConfig = dockerComposeFile.getConfiguration(
      this.options
    );

    await dockerCompose.down({
      configAsString: dockerComposeConfig,
      composeOptions: [['--verbose']],
    });
  }
}

/**
 *
 * @returns {Promise<{endpoint: number}>}
 */
async function setUpStepFunctions(options) {
  const dockerComposeConfig = dockerComposeFile.getConfiguration(options);
  let dockerResult;
  try {
    dockerResult = await dockerCompose.upAll({
      configAsString: dockerComposeConfig,
      composeOptions: [['--verbose']],
    });
  } catch (e) {
    console.error('Error setting up', e);
    throw e;
  }

  debug(dockerResult);
  // TODO accept endpoint as parameter
  return {
    endpoint: `http://localhost:${constants.DEFAULT_STEP_FUNCTIONS_PORT}`,
  };
}

module.exports = TestRunner;
