/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */

import * as CloudFormation from 'aws-sdk/clients/cloudformation';
import * as AWS from 'aws-sdk/global';

import awaitSsmCommand from '../../common/functions/awaitSsmCommand';

// Name of testing stack is derived from env variable to ensure uniqueness
const testingStackName = 'RFDKInteg-WFS-TestingTier' + process.env.INTEG_STACK_TAG!.toString();

const cloudformation = new CloudFormation();

const bastionRegex = /bastionId/;
const rqRegex = /renderQueueEndpointWFS(\d)/;
const certRegex = /CertSecretARNWFS(\d)/;

const testCases: Array<Array<any>> = [
  [ 'Linux Worker HTTPS (TLS) mode', 1 ],
  [ 'Windows Worker HTTPS (TLS) mode', 2 ],
];
let bastionId: any;
let renderQueueEndpoints: Array<string> = [];
let secretARNs: Array<string> = [];

beforeAll( () => {
  // Query the TestingStack and await its outputs to use as test inputs
  return new Promise( (res,rej) => {
    var params = {
      StackName: testingStackName,
    };
    cloudformation.describeStacks(params, (err, data) => {
      if (err) {
        rej(err);
      }
      else {
        var stackOutput = data.Stacks![0].Outputs!;
        stackOutput.forEach( output => {
          var outputKey = output.OutputKey!;
          var outputValue = output.OutputValue!;
          switch(true){
            case bastionRegex.test(outputKey):
              bastionId = outputValue;
              break;
            case rqRegex.test(outputKey):
              var testId = rqRegex.exec(outputKey)![1];
              renderQueueEndpoints[+testId] = outputValue;
              break;
            case certRegex.test(outputKey):
              var testId = certRegex.exec(outputKey)![1];
              secretARNs[+testId] = outputValue;
              break;
            default:
              break;
          }
        });
        res();
      }
    });
  });
});

describe.each(testCases)('Deadline WorkerFleetHttps tests (%s)', (_, id) => {

  beforeAll( () => {
    if(secretARNs[id]) {
      //If the secretARN has been provided for the auth certificate, this command will fetch it to the instance before continuing the tests
      var params = {
        DocumentName: 'AWS-RunShellScript',
        Comment: 'Execute Test Script fetch-cert.sh',
        InstanceIds: [bastionId],
        Parameters: {
          commands: [
            'sudo -i',
            'su - ec2-user >/dev/null',
            'cd ~ec2-user',
            './utilScripts/fetch-cert.sh \'' + AWS.config.region + '\' \'' + secretARNs[id] + '\'',
          ],
        },
      };
      return awaitSsmCommand(bastionId, params);
    }
    else {
      throw new Error(`Did not find a secrect ARN for ${testingStackName}`);
    }
  });

  // This removes the certification file used to authenticate to the render queue
  afterAll( () => {
    var params = {
      DocumentName: 'AWS-RunShellScript',
      Comment: 'Execute Test Script cleanup-cert.sh',
      InstanceIds: [bastionId],
      Parameters: {
        commands: [
          'sudo -i',
          'su - ec2-user >/dev/null',
          'cd ~ec2-user',
          './utilScripts/cleanup-cert.sh',
        ],
      },
    };
    return awaitSsmCommand(bastionId, params);
  });

  describe('Worker node tests', () => {

    // Before testing the render queue, send a command to configure the Deadline client to use that endpoint
    beforeAll( () => {
      var params = {
        DocumentName: 'AWS-RunShellScript',
        Comment: 'Execute Test Script configure-deadline.sh',
        InstanceIds: [bastionId],
        Parameters: {
          commands: [
            'sudo -i',
            'su - ec2-user >/dev/null',
            'cd ~ec2-user',
            './utilScripts/configure-deadline.sh \'' + renderQueueEndpoints[id] + '\'',
          ],
        },
      };
      return awaitSsmCommand(bastionId, params);
    });

    test(`WFS-${id}-1: Workers can be attached to the Render Queue`, async () => {
      /**********************************************************************************************************
       * TestID:          WFS-1
       * Description:     Confirm that workers can be attached to the farm's render queue
       * Input:           Output from `deadlinecommand Slaves` executed against the farm's render queue via SSM command
       * Expected result: Ouput should be a string beginning with ip- to indicate the worker node is attached to the farm
      **********************************************************************************************************/
      var params = {
        DocumentName: 'AWS-RunShellScript',
        Comment: 'Execute Test Script WFS-report-workers.sh',
        InstanceIds: [bastionId],
        Parameters: {
          commands: [
            'sudo -i',
            'su - ec2-user >/dev/null',
            'cd ~ec2-user',
            './testScripts/WFS-report-workers.sh',
          ],
        },
      };
      return awaitSsmCommand(bastionId, params).then( response => {
        var responseOutput = response.output;
        expect(responseOutput).toMatch(/ip-.*/);
      });
    });

    test(`WFS-${id}-2: Workers can be added to groups, pools and regions`, async () => {
      /**********************************************************************************************************
       * TestID:          WFS-2
       * Description:     Confirm that workers can be added to groups, pools, and regions when those parameters are passed to the constructor
       * Input:           Output from `deadline GetSlaveSetting` for each worker executed agains the farm's render queue via SSM command
       * Expected result: Output of the worker settings should indicate that 1 worker is assigned to group "testgroup", pool "testpool" and region "testregion"
      **********************************************************************************************************/
      var params = {
        DocumentName: 'AWS-RunShellScript',
        Comment: 'Execute Test Script WFS-report-worker-sets.sh',
        InstanceIds: [bastionId],
        Parameters: {
          commands: [
            'sudo -i',
            'su - ec2-user >/dev/null',
            'cd ~ec2-user',
            './testScripts/WFS-report-worker-sets.sh',
          ],
        },
      };
      return awaitSsmCommand(bastionId, params).then( response => {
        var responseOutput = response.output;
        expect(responseOutput).toMatch(/testpool\ntestgroup\ntestregion/);
      });
    });

    const setConfigs: Array<Array<any>> = [
      [3,'group','-group testgroup'],
      [4,'pool','-pool testpool'],
    ];

    // eslint-disable-next-line @typescript-eslint/no-shadow
    test.each(setConfigs)(`WFS-${id}-%i: Workers can be assigned jobs submitted to a %s`, async (_, name, arg) => {
      /**********************************************************************************************************
       * TestID:          WFS-3, WFS-4
       * Description:     Confirm that jobs sent to a specified group/pool/region are routed to a worker in that set
       * Input:           Output from `deadline GetSlavesRenderingJob` for each test job executed agains the farm's render queue via SSM command
       * Expected result: Output of the worker lists should indicate that 1 worker was assigned a job in group "testgroup", pool "testpool", and region "testregion"
      **********************************************************************************************************/
      var params = {
        DocumentName: 'AWS-RunShellScript',
        Comment: `Execute Test Script WFS-submit-jobs-to-sets.sh for ${name}`,
        InstanceIds: [bastionId],
        Parameters: {
          commands: [
            'sudo -i',
            'su - ec2-user >/dev/null',
            'cd ~ec2-user',
            `./testScripts/WFS-submit-jobs-to-sets.sh "${name}" "${arg}"`,
          ],
        },
      };
      return awaitSsmCommand(bastionId, params).then( response => {
        var responseOutput = response.output;
        expect(+responseOutput).toBe(1);
      });
    });
  });
});