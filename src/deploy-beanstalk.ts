#!/usr/bin/env node
import fs from 'fs';
import AWS from 'aws-sdk';
import fetch from 'node-fetch';
import { setOutput } from '@actions/core';
import { S3, ElasticBeanstalk } from 'aws-sdk/clients/all';
// eslint-disable-next-line no-unused-vars
import { BucketName, ManagedUpload, ObjectKey } from 'aws-sdk/clients/s3';

let retriesCounter: number = 0;
const AWS_EBS_TIMEOUT: number = 30 * 1000;
const NUMBER_MAX_OF_RETRIES: number = 10;
const elasticbeanstalk: ElasticBeanstalk = new ElasticBeanstalk();

function initLogs(): void {
  console.info = (msg: string, data: any) => console.log(`::info::${msg}`, data);
  console.error = (msg: string, data: any) => console.log(`::error::${msg}`, data);
  console.warn = (msg: string, data: any) => console.log(`::warning::${msg}`, data);
  console.log(
    'Deploy-aws-beanstalk: GitHub Action for deploying a project in AWS Elastic Beanstalk.',
  );
}

function parseArgs(): {
  region: string;
  s3Data: {
    key: ObjectKey;
    filePath: string;
    bucketName: BucketName;
  };
  description: string;
  versionLabel: string;
  accessKeyId: string;
  expectedVersion: string;
  secretAccessKey: string;
  environmentName: string;
  applicationName: string;
  updatedVersionUrl: string;
  waitForEnvToBeGreen: boolean;
} {
  const region: string = (process.env.INPUT_REGION || '').trim();
  const accessKeyId: string = (process.env.INPUT_AWS_ACCESS_KEY || '').trim();
  const secretAccessKey: string = (process.env.INPUT_AWS_SECRET_KEY || '').trim();
  const environmentName: string = (process.env.INPUT_ENVIRONMENT_NAME || '').trim();
  const applicationName: string = (process.env.INPUT_APPLICATION_NAME || '').trim();
  const s3Data: any = {
    key: (process.env.INPUT_S3_BUCKET_KEY || '').trim(),
    bucketName: (process.env.INPUT_S3_BUCKET_NAME || '').trim(),
    filePath: (process.env.INPUT_S3_FILE_PATH || '').trim(),
  };
  const description: string = (process.env.INPUT_EBS_DESCRIPTION || '').trim();
  const versionLabel: string = (process.env.INPUT_EBS_VERSION_LABEL || '').trim();
  const waitForEnvToBeGreen: boolean = /true/i.test(
    process.env.INPUT_EBS_WAIT_FOR_ENV_TO_BE_GREEN || '',
  );
  const expectedVersion: string = (process.env.INPUT_EXPECTED_VERSION || '').trim();
  const updatedVersionUrl: string = (process.env.INPUT_UPDATED_VERSION_URL || '').trim();

  const displayError = (error: string) =>
    console.error(`Error: ${error} was not specified in the arguments with.`);

  if (!region) {
    displayError('Region');
    process.exit(1);
  }
  if (!environmentName) {
    displayError("Environment's name");
    process.exit(1);
  }
  if (!accessKeyId) {
    displayError('AWS Access Key');
    process.exit(1);
  }
  if (!secretAccessKey) {
    displayError('AWS Secret Key');
    process.exit(1);
  }
  if (!applicationName) {
    displayError("Application's name");
    process.exit(1);
  }
  if (!versionLabel) {
    displayError("Version's label");
    process.exit(1);
  }
  if (!s3Data.key) {
    displayError("AWS S3 bucket's file name");
    process.exit(1);
  }
  if (!s3Data.bucketName) {
    displayError("AWS S3 bucket's name");
    process.exit(1);
  }
  if (!s3Data.filePath) {
    displayError('AWS S3 file path');
    process.exit(1);
  }

  return {
    region,
    s3Data,
    accessKeyId,
    description,
    versionLabel,
    expectedVersion,
    secretAccessKey,
    environmentName,
    applicationName,
    updatedVersionUrl,
    waitForEnvToBeGreen,
  };
}

const handleErrors = ({ step, error }: { step: string; error: any }) => {
  console.error(`Error: An error occured during ${step} with the following error.`, { error });
  process.exit(1);
};

const connectToAWS = ({
  region,
  onSuccess,
  accessKeyId,
  secretAccessKey,
}: {
  region: string;
  onSuccess: Function;
  accessKeyId: string;
  secretAccessKey: string;
}): void => {
  const config = new AWS.Config({
    region,
    accessKeyId,
    secretAccessKey,
  });
  AWS.config.update({ region, accessKeyId, secretAccessKey });
  config.getCredentials((error) => {
    if (error) {
      console.error('Checking failed: Error while authenticating in AWS.', { stack: error.stack });
      process.exit(1);
    }
    onSuccess();
  });
};

// We will work as the bucket is already created
// We can improve the application to call the funciton
// createBucket if needed
const uploadToS3 = ({
  key,
  filePath,
  bucketName,
}: {
  key: ObjectKey;
  filePath: string;
  bucketName: BucketName;
}) => ({ onSuccess, onError }: { onSuccess: Function; onError: Function }): void => {
  const s3: S3 = new S3();
  const fileData: string = fs.readFileSync(filePath, 'utf8');
  const params: S3.Types.PutObjectRequest = { Bucket: bucketName, Key: key, Body: fileData };
  const options: ManagedUpload.ManagedUploadOptions = { partSize: 10 * 1024 * 1024, queueSize: 1 };
  s3.upload(params, options, (error, data) => {
    if (error) onError({ error, step: 'uploading to S3' });
    else onSuccess(data);
  });
};

let isEnvironmentIsReady: Function;

const checkIfEnvironmentIsReady = (
  { environmentName }: { environmentName: string },
  onSuccess: Function,
) => {
  const ebsEnvParams: ElasticBeanstalk.Types.DescribeEnvironmentHealthRequest = {
    AttributeNames: ['Status', 'InstancesHealth', 'HealthStatus'],
    EnvironmentName: environmentName,
  };
  elasticbeanstalk.describeEnvironmentHealth(ebsEnvParams, (error, data) => {
    retriesCounter += 1;
    if (error) handleErrors({ step: 'checking if the env is ready', error });
    const { Status, HealthStatus, InstancesHealth } = data;
    if (retriesCounter === NUMBER_MAX_OF_RETRIES) {
      handleErrors({
        step: 'checking if the env is ready',
        error: 'The maximum number of retires reached, please check your AWS EBS',
      });
    }
    if (
      HealthStatus?.toLowerCase() === 'ok' &&
      Status?.toLowerCase() === 'green' &&
      InstancesHealth?.Ok === 1
    ) {
      onSuccess();
    } else {
      isEnvironmentIsReady({ environmentName }, onSuccess);
    }
  });
};

isEnvironmentIsReady = (
  { environmentName }: { environmentName: string },
  onSuccess: Function,
): void => {
  setTimeout(() => {
    checkIfEnvironmentIsReady({ environmentName }, onSuccess);
  }, AWS_EBS_TIMEOUT);
};

const waitForEnvironmentToBeGreen = () => {
  setTimeout(() => {}, AWS_EBS_TIMEOUT);
};

const onDeploymentComplete = (data: any) => {
  console.log('Congratulations, your deployment is complete. Wahoo!');
  Object.entries(data).forEach(([key, value]) => setOutput(key, JSON.stringify(value)));
  process.exit(0);
};

const updateEnvironment = ({
  versionLabel,
  environmentName,
  expectedVersion,
  updatedVersionUrl,
  waitForEnvToBeGreen,
}: {
  versionLabel: string;
  environmentName: string;
  expectedVersion: string;
  updatedVersionUrl: string;
  waitForEnvToBeGreen: boolean;
}) => {
  isEnvironmentIsReady({ environmentName }, (isReady: boolean): void => {
    if (isReady) {
      const ebsEnvParams = {
        EnvironmentName: environmentName,
        VersionLabel: versionLabel,
      };
      elasticbeanstalk.updateEnvironment(ebsEnvParams, (error, data) => {
        if (error) handleErrors({ step: 'updating the env', error });
        if (waitForEnvToBeGreen) {
          waitForEnvironmentToBeGreen();
        } else if (updatedVersionUrl && expectedVersion) {
          fetch(updatedVersionUrl)
            .then((response) => response.json())
            .then((json) => {
              const stringifyResponse = JSON.stringify(json);
              if (stringifyResponse.includes(expectedVersion)) {
                console.group('Checking AWS EBS version:');
                console.log('          JSON response: ', stringifyResponse);
                console.log('       Expected version: ', expectedVersion);
                console.groupEnd();
                onDeploymentComplete(data);
              } else {
                handleErrors({
                  step: 'checking if the version is deployed',
                  error: {
                    message: 'the expected version is not the same as the one deployed',
                    response: stringifyResponse,
                  },
                });
              }
            });
        } else {
          onDeploymentComplete(data);
        }
      });
    } else {
      handleErrors({ step: 'checking EBS Environment is ready', error: {} });
    }
  });
};

const createApplicationVersion = ({
  description,
  versionLabel,
  applicationName,
  environmentName,
  expectedVersion,
  updatedVersionUrl,
  waitForEnvToBeGreen,
}: {
  description: string;
  versionLabel: string;
  applicationName: string;
  environmentName: string;
  expectedVersion: string;
  updatedVersionUrl: string;
  waitForEnvToBeGreen: boolean;
}): Function => ({ Key, Bucket }: { Key: string; Bucket: string }): void => {
  const ebsParams = {
    ApplicationName: applicationName,
    AutoCreateApplication: true,
    Description: description || '',
    Process: true,
    SourceBundle: {
      S3Bucket: Bucket,
      S3Key: Key,
    },
    VersionLabel: versionLabel,
  };

  elasticbeanstalk.createApplicationVersion(ebsParams, (error) => {
    if (error) handleErrors({ error, step: 'Creating EBS application version' });
    else
      updateEnvironment({
        environmentName,
        versionLabel,
        expectedVersion,
        updatedVersionUrl,
        waitForEnvToBeGreen,
      });
  });
};

function init(): void {
  initLogs();
  const {
    region,
    s3Data,
    description,
    accessKeyId,
    versionLabel,
    expectedVersion,
    secretAccessKey,
    environmentName,
    applicationName,
    updatedVersionUrl,
    waitForEnvToBeGreen,
  } = parseArgs();

  console.group('Deploying an application in AWS EBS with arguments:');
  console.log("          Environment's name: ", environmentName);
  console.log('                  AWS Region: ', region);
  console.log("          Application's Name: ", applicationName);
  console.log('            AWS EB file path: ', s3Data.filePath);
  console.log('              S3 Bucket file: ', s3Data.key);
  console.log('    Wait for Env to be green: ', waitForEnvToBeGreen);
  console.log('       AWS EBS version label: ', versionLabel);
  console.log(' AWS EBS url version checker: ', updatedVersionUrl);
  console.log('    AWS EBS expected version: ', expectedVersion);
  console.groupEnd();

  connectToAWS({
    region,
    accessKeyId,
    secretAccessKey,
    onSuccess: () =>
      uploadToS3(s3Data)({
        onSuccess: createApplicationVersion({
          description,
          versionLabel,
          applicationName,
          environmentName,
          expectedVersion,
          updatedVersionUrl,
          waitForEnvToBeGreen,
        }),
        onError: handleErrors,
      }),
  });
}

init();
