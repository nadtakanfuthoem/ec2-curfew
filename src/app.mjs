import { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const ec2 = new EC2Client();
const ddb = new DynamoDBClient();
const sns = new SNSClient();

const INSTANCE_TAG_KEY = 'AutoSchedule';
const INSTANCE_TAG_VALUE = 'on';
const LOG_TABLE_NAME = process.env.LOG_TABLE_NAME || 'Ec2CurfewLogs';
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN; // Set this in Lambda environment

/**
 * Lambda handler for EventBridge scheduled events.
 * Expects event.detail.mode or event.mode to be 'start' or 'stop'.
 * If not present, falls back to process.env.MODE.
 */
export const lambdaHandler = async (event, context) => {
  // EventBridge scheduled events may have mode in event.detail or event.mode
  const mode =
    (event.detail && event.detail.mode) ||
    event.mode ||
    process.env.MODE;

  if (!['start', 'stop'].includes(mode)) {
    await logToDynamoDB({
      mode,
      status: 'error',
      message: `Invalid mode: ${mode}. Use "start" or "stop".`,
      timestamp: new Date().toISOString(),
    });
    throw new Error(`Invalid mode: ${mode}. Use "start" or "stop".`);
  }

  try {
    // 1. Get instances with tag AutoSchedule=on
    const instances = await getTaggedInstances(INSTANCE_TAG_KEY, INSTANCE_TAG_VALUE);

    if (instances.length === 0) {
      await logToDynamoDB({
        mode,
        status: 'no-instances',
        message: 'No matching instances found.',
        timestamp: new Date().toISOString(),
      });
      console.log('No matching instances found.');
      return;
    }

    const instanceIds = instances.map(i => i.InstanceId);
    console.log(`Found instances: ${instanceIds.join(', ')}`);

    // 2. Start or Stop based on mode
    if (mode === 'start') {
      await ec2.send(new StartInstancesCommand({ InstanceIds: instanceIds }));
      await logToDynamoDB({
        mode,
        status: 'started',
        instanceIds,
        timestamp: new Date().toISOString(),
      });
      console.log(`Started instances: ${instanceIds.join(', ')}`);
    } else if (mode === 'stop') {
      // Send SNS notification before stopping
      if (SNS_TOPIC_ARN) {
        await sendSnsNotification(instanceIds);
      }
      await ec2.send(new StopInstancesCommand({ InstanceIds: instanceIds }));
      await logToDynamoDB({
        mode,
        status: 'stopped',
        instanceIds,
        timestamp: new Date().toISOString(),
      });
      console.log(`Stopped instances: ${instanceIds.join(', ')}`);
    }
  } catch (err) {
    await logToDynamoDB({
      mode,
      status: 'error',
      message: err.message,
      timestamp: new Date().toISOString(),
    });
    console.error('Error managing EC2 instances:', err);
    throw err;
  }
};

// Helper: Find EC2 instances by tag
async function getTaggedInstances(tagKey, tagValue) {
  const result = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: `tag:${tagKey}`, Values: [tagValue] },
      { Name: 'instance-state-name', Values: ['running', 'stopped'] },
    ],
  }));

  const instances = [];
  for (const reservation of result.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      instances.push(instance);
    }
  }
  return instances;
}

// Helper: Log to DynamoDB
async function logToDynamoDB(log) {
  const params = {
    TableName: LOG_TABLE_NAME,
    Item: {
      LogId: { S: `${Date.now()}-${Math.random().toString(36).slice(2)}` },
      Mode: { S: log.mode || 'unknown' },
      Status: { S: log.status },
      Timestamp: { S: log.timestamp },
      Message: log.message ? { S: log.message } : undefined,
      InstanceIds: log.instanceIds
        ? { SS: log.instanceIds.map(String) }
        : undefined,
    },
  };

  // Remove undefined fields
  Object.keys(params.Item).forEach(
    (k) => params.Item[k] === undefined && delete params.Item[k]
  );

  await ddb.send(new PutItemCommand(params));
}

// Helper: Send SNS notification before stopping EC2
async function sendSnsNotification(instanceIds) {
  const params = {
    TopicArn: SNS_TOPIC_ARN,
    Subject: 'EC2 Curfew: Instances will be stopped',
    Message: `The following EC2 instances will be stopped: ${instanceIds.join(', ')}`,
  };
  await sns.send(new PublishCommand(params));
}