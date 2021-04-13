// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as path from 'path';

import * as fs from 'fs-extra';

import { sleep } from './uitils';
import {
  getPublishStatus,
  setAppsettings,
  startPublish,
  getProjectTemplates,
  createSampleBot,
  getJobStatus,
} from './composerApi';
import { getAccessToken } from './azureTokenUtils';
import { DirectLineUtils } from './directLineUtils';

jest.setTimeout(1000 * 60 * 10);

const directlineToken = process.env.DAILY_CI_DIRECTLINE_TOKEN ?? '';

function getPublishProfile(): Record<string, unknown> {
  const publishFile = process.env.DAILY_CI_PUBLISH_FILE;
  if (!publishFile) {
    return undefined;
  }

  return JSON.parse(publishFile.trim());
}

async function setAppSettings(token: string, botId: string, botName: string, testPublishFile) {
  let publishProfile = getPublishProfile();
  if (!publishProfile) {
    publishProfile = testPublishFile;
  }
  publishProfile.accessToken = token;
  const publishProfileStr = JSON.stringify(publishProfile);

  const defaultSettingsPath = path.resolve(__dirname, 'defaultPublishSettings.json');
  const defaultSettings = await fs.readJSON(defaultSettingsPath);
  defaultSettings.luis.name = botName;
  defaultSettings.publishTargets = [
    {
      name: botName,
      type: 'azurePublish',
      configuration: publishProfileStr,
      lastPublished: Date.now(),
    },
  ];

  return await setAppsettings(defaultSettings, botId);
}

async function createTemplateProject(templateName: string, templateVersion: string) {
  let retryCount = 10;
  const response = await createSampleBot(templateName, templateVersion);
  let responseData = undefined;
  while (retryCount > 0) {
    responseData = await getJobStatus(response.jobId);

    if (responseData.statusCode === 200 && responseData.message === 'Created Successfully') {
      break;
    }

    await sleep(5000);
    retryCount--;
  }

  if (retryCount <= 0) {
    throw new Error('Get getJobStatus failed.');
  }

  return responseData;
}

async function publishBot(botId: string, botName: string, testPublishFile, metadata): Promise<boolean> {
  const tokenResponse = await getAccessToken();
  const jsonResult = JSON.parse(tokenResponse);
  const token = jsonResult.accessToken;

  const updateSettingsResult = await setAppSettings(token, botId, botName, testPublishFile);

  if (!updateSettingsResult) {
    return false;
  }

  const startPublishResult = await startPublish(token, botId, botName, metadata);
  if (!startPublishResult) {
    return false;
  }

  let message = undefined;
  while (message !== 'Success') {
    const statusResult = await getPublishStatus(botId, botName);
    if (!statusResult) {
      return false;
    }
    message = statusResult?.message;
    await sleep(1000);
  }
  return true;
}

describe('test sample bot', () => {
  it('run test', async () => {
    const templates = await getProjectTemplates();
    if (!Array.isArray(templates)) {
      throw new Error('templates is not array.');
    }

    const testDataPath = path.resolve(__dirname, 'testData.json');
    const testData = await fs.readJSON(testDataPath);

    for (const template of templates) {
      const packageName = template?.package?.packageName;
      const packageVersion = template?.package?.packageVersion;
      const templateSettings = testData.filter((u) => u.packageName === packageName);

      if (templateSettings.length === 0) {
        continue;
      }

      const templatesetting = templateSettings[0];
      const projectInfo = await createTemplateProject(packageName, packageVersion);
      console.log('create project successfully.');
      console.log(projectInfo);
      const botId = projectInfo.result.id;
      const botName = projectInfo.result.botName;

      // publish test
      const publishResult = await publishBot(botId, botName, templatesetting.publishFile, templatesetting.metadata);
      expect(publishResult).toBeTruthy();

      console.log('publish project successfully.');

      // flow test
      const tester = new DirectLineUtils(directlineToken);
      const tests = templatesetting.testdata;
      for (const test of tests) {
        const results = await tester.sendAndGetMessages(test.sendMessage);
        const expectedResults = test.expectedResults;
        expect(expectedResults).toContain(results[0].trim());
      }
      console.log('test project successfully.');
    }
  });
});