/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';
import { BastionHostLinux, InstanceType, Port, SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { FileSystem } from '@aws-cdk/aws-efs';
import { ILogGroup } from '@aws-cdk/aws-logs';
import { Asset } from '@aws-cdk/aws-s3-assets';
import { CfnOutput, Construct, Duration, Stack, StackProps } from '@aws-cdk/core';
import { X509CertificatePem, MongoDbInstaller, MongoDbSsplLicenseAcceptance, MongoDbVersion } from 'aws-rfdk';
import { IWorkerFleet, RenderQueue, Repository } from 'aws-rfdk/deadline';
import { RenderStruct } from './render-struct';
import { StorageStruct, IRenderFarmDb } from './storage-struct';
import { WorkerStruct } from './worker-struct';

// Interface for choosing userData installation options
interface UserDataConfigProps {
  installDeadlineClient: boolean;
  fetchDocdbCert: boolean;
  testingScriptPath: string;
}

// Params object for TestingTier
export interface TestingTierProps extends StackProps {
  integStackTag: string;
}

// Class constructor
export class TestingTier extends Stack {

  private testInstance: BastionHostLinux;
  private deadlineVersion: string = process.env.DEADLINE_VERSION!.toString();
  private stagePath: string = process.env.DEADLINE_STAGING_PATH!.toString();

  constructor(scope: Construct, id: string, props: TestingTierProps) {
    super(scope, id, props);

    // Collect environment variables
    const infrastructureStackName = 'RFDKIntegInfrastructure' + props.integStackTag;

    // Vpc.fromLookup acquires vpc deployed to the _infrastructure stack
    const vpc = Vpc.fromLookup(this, 'Vpc', { tags: { StackName: infrastructureStackName }}) as Vpc;

    // Create an instance that can be used for testing; SSM commands are communicated to the
    // host instance to run test scripts installed during setup of the instance
    const testInstance: BastionHostLinux = new BastionHostLinux(this, 'Bastion', {
      vpc,
      instanceType: new InstanceType('t3.small'),
      subnetSelection: {
        subnetType: SubnetType.PRIVATE,
      },
    });
    this.testInstance = testInstance;

    // Output bastion id for use in tests
    new CfnOutput(this, 'bastionId', {
      value: testInstance.instanceId,
    });

  }

  // Each test suite has an associated public function which calls on several of this class's private functions to set up the test bastion
  public configureRepositoryTest(structs:Array<StorageStruct>) {
    structs.forEach( storageStruct => {

      const testSuiteId = 'DL' + (structs.indexOf(storageStruct) + 1).toString();

      const repo = storageStruct.repo;
      this.configureRepo(testSuiteId, repo);

      const database = storageStruct.database;
      this.configureDatabase(testSuiteId, database);

      const efs = storageStruct.efs;
      this.configureEfs(efs);

      const cert = storageStruct.database.cert;
      this.configureCert(testSuiteId, cert);
    });

    this.configureBastionUserData({
      installDeadlineClient: false,
      fetchDocdbCert: true,
      testingScriptPath: '../components/deadline/deadline_01_repository/scripts/bastion/testing',
    });

    this.configureMongodb();
  }

  public configureRenderQueueTest( structs:Array<RenderStruct>) {
    structs.forEach( renderStruct => {

      const testSuiteId = 'RQ' + (structs.indexOf(renderStruct) + 1).toString();

      const renderQueue = renderStruct.renderQueue;
      this.configureRenderQueue(testSuiteId, renderQueue);

      const cert = renderStruct.cert;
      this.configureCert(testSuiteId, cert);

    });

    this.configureBastionUserData({
      installDeadlineClient: true,
      fetchDocdbCert: false,
      testingScriptPath: '../components/deadline/deadline_02_renderQueue/scripts/bastion/testing',
    });
  }

  public configureWorkerFleetTest( structs:Array<WorkerStruct>) {
    structs.forEach( workerStruct => {

      const testSuiteId = 'WF' + (structs.indexOf(workerStruct) + 1).toString();

      const renderQueue = workerStruct.renderQueue;
      this.configureRenderQueue(testSuiteId, renderQueue);

      const cert = workerStruct.cert;
      this.configureCert(testSuiteId, cert);

      const workerFleet = workerStruct.workerFleet;
      this.configureWorkerFleet(workerFleet);
    });

    this.configureBastionUserData({
      installDeadlineClient: true,
      fetchDocdbCert: false,
      testingScriptPath: '../components/deadline/deadline_03_workerFleet/scripts/bastion/testing',
    });
  }

  // Grants the bastion permissions to read the renderQueue cert and creates a stack output for its secretARN
  private configureCert(testSuiteId:string, cert?:X509CertificatePem) {
    if(cert) {
      cert.cert.grantRead(this.testInstance);
      new CfnOutput(this, 'certSecretARN' + testSuiteId, {
        value: cert.cert.secretArn,
      });
    };
  }

  // Allows the bastion to connect to the docDB/mongoDB instance and creates a stack output for the secretARN for the database
  private configureDatabase(testSuiteId:string, database:IRenderFarmDb) {
    const db = database.db;
    const dbSecret = database.secret!;

    this.testInstance.connections.allowTo(db, Port.tcp(27017));
    dbSecret.grantRead(this.testInstance);

    new CfnOutput(this, 'secretARN' + testSuiteId, {
      value: dbSecret.secretArn,
    });
  }

  // Allows the bastion to connect to the repository's EFS file system
  configureEfs(efs:FileSystem) {
    this.testInstance.connections.allowToDefaultPort(efs);
  }

  // Configures the local instance of mongo DB on the bastion for reading from the repository
  private configureMongodb() {
    const userAcceptsSSPL = process.env.USER_ACCEPTS_SSPL_FOR_RFDK_TESTS;
    if (userAcceptsSSPL){
      const userSsplAcceptance =
        userAcceptsSSPL.toString() === 'true' ? MongoDbSsplLicenseAcceptance.USER_ACCEPTS_SSPL : MongoDbSsplLicenseAcceptance.USER_REJECTS_SSPL;
      const mongodbInstaller = new MongoDbInstaller(this, {
        version: MongoDbVersion.COMMUNITY_3_6,
        userSsplAcceptance,
      });
      mongodbInstaller.installOnLinuxInstance(this.testInstance.instance);
    }
  }

  // Configures connections on the farm's render queue to allow the bastion access
  private configureRenderQueue(testSuiteId: string, renderQueue:RenderQueue) {
    const port = renderQueue.endpoint.portAsString();
    const zoneName = Stack.of(renderQueue).stackName + '.local';
    var address;
    switch(port) {
      case '8080':
        address = renderQueue.endpoint.hostname;
        break;
      case '4433':
        address = 'renderqueue.' + zoneName;
        break;
      default:
        break;
    }

    this.testInstance.connections.allowToDefaultPort(renderQueue);
    this.testInstance.connections.allowTo(renderQueue, Port.tcp(22));

    const renderQueueEndpoint = `${address}:${port}`;
    new CfnOutput(this, 'renderQueueEndpoint' + testSuiteId, {
      value: renderQueueEndpoint,
    });
  }

  // Mounts the Deadline repository's file system to the bastion and outputs the name of its log group
  private configureRepo(testSuiteId:string, repo:Repository) {
    const logGroup = repo.node.findChild('RepositoryLogGroup') as ILogGroup;
    const logGroupName = logGroup.logGroupName;

    repo.fileSystem.mountToLinuxInstance(this.testInstance.instance, {
      location: '/mnt/efs/fs' + testSuiteId.toLowerCase(),
    });

    new CfnOutput(this, 'logGroupName' + testSuiteId, {
      value: logGroupName,
    });
  }

  // Configures each worker to allow access from the bastion
  private configureWorkerFleet(workerFleet:Array<IWorkerFleet>) {
    workerFleet.forEach( worker => {
      this.testInstance.connections.allowTo(worker, Port.tcp(22));
    });
  }


  // Configures assets to install on the bastion via userData
  private configureBastionUserData(props:UserDataConfigProps) {

    this.testInstance.instance.instance.cfnOptions.creationPolicy = {
      ...this.testInstance.instance.instance.cfnOptions.creationPolicy,
      resourceSignal: {
        timeout: Duration.minutes(5).toISOString(),
        count: 1,
      },
    };

    const userDataCommands = [];

    userDataCommands.push(
      'set -xeou pipefail',
      'TMPDIR=$(mktemp -d)',
      'cd "${TMPDIR}"',
    );

    const instanceSetupScripts = new Asset(this, 'SetupScripts', {
      path: path.join(__dirname, '..', 'components', 'deadline', 'common', 'scripts', 'bastion', 'setup'),
    });
    instanceSetupScripts.grantRead(this.testInstance);
    const setupZipPath: string = this.testInstance.instance.userData.addS3DownloadCommand({
      bucket: instanceSetupScripts.bucket,
      bucketKey: instanceSetupScripts.s3ObjectKey,
    });

    userDataCommands.push(
      // Unzip & run the instance setup scripts
      `unzip ${setupZipPath}`,
      'chmod +x *.sh',
      './install_jq.sh',
    );

    if( props.installDeadlineClient ) {
      const clientInstaller = new Asset(this, 'ClientInstaller', {
        path: path.join(this.stagePath, 'bin', 'DeadlineClient-' + this.deadlineVersion + '-linux-x64-installer.run'),
      });
      clientInstaller.grantRead(this.testInstance);
      const installerPath: string = this.testInstance.instance.userData.addS3DownloadCommand({
        bucket: clientInstaller.bucket,
        bucketKey: clientInstaller.s3ObjectKey,
      });

      userDataCommands.push(
        `cp ${installerPath} ./deadline-client-installer.run`,
        'chmod +x *.run',
        './install_deadline_client.sh',
        `rm -f ${installerPath}`,
      );
    }

    userDataCommands.push(
      `rm -f ${setupZipPath}`,
    );

    const instanceUtilScripts = new Asset(this, 'UtilScripts', {
      path: path.join(__dirname, '..', 'components', 'deadline', 'common', 'scripts', 'bastion', 'utils'),
    });
    instanceUtilScripts.grantRead(this.testInstance);
    const utilZipPath: string = this.testInstance.instance.userData.addS3DownloadCommand({
      bucket: instanceUtilScripts.bucket,
      bucketKey: instanceUtilScripts.s3ObjectKey,
    });

    userDataCommands.push(
      // Unzip the utility scripts to: ~ec2-user/utilScripts/
      'cd ~ec2-user',
      'mkdir -p utilScripts',
      'cd utilScripts',
      `unzip ${utilZipPath}`,
      'chmod +x *.sh',
      `rm -f ${utilZipPath}`,
    );

    const testingScripts = new Asset(this, 'TestingScripts', {
      path: path.join(__dirname, props.testingScriptPath),
    });
    testingScripts.grantRead(this.testInstance);
    const testsZipPath: string = this.testInstance.instance.userData.addS3DownloadCommand({
      bucket: testingScripts.bucket,
      bucketKey: testingScripts.s3ObjectKey,
    });

    userDataCommands.push(
      // Unzip the testing scripts to: ~ec2-user/testScripts/
      'cd ~ec2-user',
      'mkdir -p testScripts',
      'cd testScripts',
      `unzip ${testsZipPath}`,
      'chmod +x *.sh',
      `rm -f ${testsZipPath}`,
    );

    if( props.fetchDocdbCert ) {
      userDataCommands.push(
        // Put the DocDB CA certificate in the testing directory.
        'cd ~ec2-user',
        'mkdir -p testScripts',
        'cd testScripts',
        'wget https://s3.amazonaws.com/rds-downloads/rds-combined-ca-bundle.pem',
      );
    }

    userDataCommands.push(
      // Unzip the testing scripts to: ~ec2-user/testScripts/
      // Everything will be owned by root, by default (UserData runs as root)
      'cd ~ec2-user',
      'chown ec2-user.ec2-user -R *',
      // Cleanup
      'rm -rf "${TMPDIR}"',
    );

    this.testInstance.instance.userData.addCommands( ...userDataCommands );
    this.testInstance.instance.userData.addSignalOnExitCommand( this.testInstance.instance );
  }
}
