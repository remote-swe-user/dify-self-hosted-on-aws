import { CpuArchitecture, FargateTaskDefinition, ICluster } from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';
import { CfnOutput, Stack, aws_ecs as ecs } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Postgres } from '../postgres';
import { Redis } from '../redis';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { IAlb } from '../alb';
import { IRepository } from 'aws-cdk-lib/aws-ecr';
import { getAdditionalEnvironmentVariables, getAdditionalSecretVariables } from './environment-variables';
import { EnvironmentProps } from '../../environment-props';

export interface ConsoleServiceProps {
  cluster: ICluster;
  alb: IAlb;

  postgres: Postgres;
  redis: Redis;
  storageBucket: IBucket;

  imageTag: string;

  customRepository?: IRepository;

  additionalEnvironmentVariables: EnvironmentProps['additionalEnvironmentVariables'];
}

/**
 * An ad-hoc service to execute any CLI commands in Dify context.
 */
export class ConsoleService extends Construct {
  constructor(scope: Construct, id: string, props: ConsoleServiceProps) {
    super(scope, id);

    const { cluster, alb, postgres, redis, storageBucket, customRepository } = props;

    const taskDefinition = new FargateTaskDefinition(this, 'Task', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: CpuArchitecture.X86_64 },
    });

    taskDefinition.addContainer('Main', {
      image: customRepository
        ? ecs.ContainerImage.fromEcrRepository(customRepository, `dify-api_${props.imageTag}`)
        : ecs.ContainerImage.fromRegistry(`langgenius/dify-api:${props.imageTag}`),
      // https://docs.dify.ai/getting-started/install-self-hosted/environments
      environment: {
        MODE: 'api',
        // The base URL of console application web frontend, refers to the Console base URL of WEB service if console domain is
        // different from api or web app domain.
        CONSOLE_WEB_URL: alb.url,
        // The base URL of console application api server, refers to the Console base URL of WEB service if console domain is different from api or web app domain.
        CONSOLE_API_URL: alb.url,
        // The URL prefix for Service API endpoints, refers to the base URL of the current API service if api domain is different from console domain.
        SERVICE_API_URL: alb.url,
        // The URL prefix for Web APP frontend, refers to the Web App base URL of WEB service if web app domain is different from console or api domain.
        APP_WEB_URL: alb.url,

        // Enable pessimistic disconnect handling for recover from Aurora automatic pause
        // https://docs.sqlalchemy.org/en/20/core/pooling.html#disconnect-handling-pessimistic
        SQLALCHEMY_POOL_PRE_PING: 'True',

        // The configurations of redis connection.
        REDIS_HOST: redis.endpoint,
        REDIS_PORT: redis.port.toString(),
        REDIS_USE_SSL: 'true',
        REDIS_DB: '0',

        // Specifies the allowed origins for cross-origin requests to the Web API, e.g. https://dify.app or * for all origins.
        WEB_API_CORS_ALLOW_ORIGINS: '*',
        // Specifies the allowed origins for cross-origin requests to the console API, e.g. https://cloud.dify.ai or * for all origins.
        CONSOLE_CORS_ALLOW_ORIGINS: '*',

        // The type of storage to use for storing user files.
        STORAGE_TYPE: 's3',
        S3_BUCKET_NAME: storageBucket.bucketName,
        S3_REGION: Stack.of(storageBucket).region,
        S3_USE_AWS_MANAGED_IAM: 'true',

        // postgres settings. the credentials are in secrets property.
        DB_DATABASE: postgres.databaseName,

        // pgvector configurations
        VECTOR_STORE: 'pgvector',
        PGVECTOR_DATABASE: postgres.pgVectorDatabaseName,

        // The sandbox service endpoint.
        CODE_EXECUTION_ENDPOINT: 'http://localhost:8194', // Fargate の task 内通信は localhost 宛,

        ...getAdditionalEnvironmentVariables(this, 'api', props.additionalEnvironmentVariables),
      },
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'log',
      }),
      secrets: {
        // The configurations of postgres database connection.
        // It is consistent with the configuration in the 'db' service below.
        DB_USERNAME: ecs.Secret.fromSecretsManager(postgres.secret, 'username'),
        DB_HOST: ecs.Secret.fromSecretsManager(postgres.secret, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(postgres.secret, 'port'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(postgres.secret, 'password'),
        PGVECTOR_USER: ecs.Secret.fromSecretsManager(postgres.secret, 'username'),
        PGVECTOR_HOST: ecs.Secret.fromSecretsManager(postgres.secret, 'host'),
        PGVECTOR_PORT: ecs.Secret.fromSecretsManager(postgres.secret, 'port'),
        PGVECTOR_PASSWORD: ecs.Secret.fromSecretsManager(postgres.secret, 'password'),
        REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redis.secret),
        CELERY_BROKER_URL: ecs.Secret.fromSsmParameter(redis.brokerUrl),
        ...getAdditionalSecretVariables(this, 'api', props.additionalEnvironmentVariables),
      },
      // https://stackoverflow.com/a/42873832
      entryPoint: ['tail'],
      command: ['-f', '/dev/null'],
    });

    storageBucket.grantReadWrite(taskDefinition.taskRole);

    taskDefinition.taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Rerank',
          'bedrock:Retrieve',
          'bedrock:RetrieveAndGenerate',
        ],
        resources: ['*'],
      }),
    );

    const service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition,
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE',
          weight: 1,
        },
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 0,
        },
      ],
      enableExecuteCommand: true,
      minHealthyPercent: 0,
      desiredCount: 0,
    });

    postgres.connections.allowDefaultPortFrom(service);
    redis.connections.allowDefaultPortFrom(service);

    new CfnOutput(Stack.of(this), 'ConsoleStartServiceCommand', {
      value: `aws ecs update-service --region ${Stack.of(this).region} --cluster ${cluster.clusterName} --service ${service.serviceName} --desired-count 1`,
    });

    new CfnOutput(Stack.of(this), 'ConsoleStopServiceCommand', {
      value: `aws ecs update-service --region ${Stack.of(this).region} --cluster ${cluster.clusterName} --service ${service.serviceName} --desired-count 0`,
    });

    new CfnOutput(Stack.of(this), 'ConsoleListTasksCommand', {
      value: `aws ecs list-tasks --region ${Stack.of(this).region} --cluster ${cluster.clusterName} --service-name ${service.serviceName} --desired-status RUNNING`,
    });

    new CfnOutput(Stack.of(this), 'ConsoleConnectToTaskCommand', {
      value: `aws ecs execute-command --region ${Stack.of(this).region} --cluster ${cluster.clusterName} --container Main --interactive --command "bash" --task TASK_ID`,
    });
  }
}
