import { generate as uniqueId } from 'shortid';
import { Construct, Aws } from '@aws-cdk/core';
import { Repository, IRepository } from '@aws-cdk/aws-codecommit';
import { Pipeline, Artifact } from '@aws-cdk/aws-codepipeline';
import { CodeCommitSourceAction, GitHubSourceAction, CodeBuildAction, CloudFormationCreateReplaceChangeSetAction } from '@aws-cdk/aws-codepipeline-actions';
import { LinuxBuildImage, BuildEnvironmentVariableType, BuildSpec, PipelineProject } from '@aws-cdk/aws-codebuild';
import { CloudFormationCapabilities } from '@aws-cdk/aws-cloudformation';
import { PolicyStatement } from '@aws-cdk/aws-iam';
import { Secret } from '@aws-cdk/aws-secretsmanager';

export enum SourceType {
  CODECOMMIT = 'codecommit',
  GITHUB = 'github'
}

export interface SimpleCicdProps {
  /**
   * Source type for the pipeline
   * @default SourceType.CODECOMMIT
   */
  sourceType?: SourceType,

  /**
   * Name of the repository that stores the code.
   */
  repositoryName: string;

  /**
   * Owner of the Github account. Required for Github repositories
   */
  accountOwner?: string;

  /**
   * Name of the branch to connect the triggers to
   * @default master
   */
  branchName?: string;

  /**
   * If the source type is CodeCommit, whether to create a new repository for the code
   * @default true
   */
  createRepository?: boolean;

  /**
   * Name for your pipeline.
   */
  pipelineName?: string;

  /**
   * Name of the stack
   */
  stackName?: string,

  /**
   * Whether to include a post-deployment stage for delivering the app
   * @default false
   */
  needsAppDelivery?: boolean;

  /**
   * ARN of the secret within AWS Secrets Manager that contains the access token. Required for Github sources
   */
  oauthSecretArn?: string;
}

export class SimpleCicd extends Construct {
  /** @returns the source repository */
  public readonly sourceRepository: IRepository;

  /** @returns the cicd pipeline */
  public readonly pipeline: Pipeline;

  /** @returns the cicd build project */
  public readonly buildProject: PipelineProject;

  /** @returns the cicd delivery project */
  public readonly deliveryProject: PipelineProject;

  constructor(scope: Construct, id: string, props: SimpleCicdProps = {
    sourceType: SourceType.CODECOMMIT,
    repositoryName: '',
    createRepository: true,
    needsAppDelivery: false
  }) {
    super(scope, id);

    const accountId = Aws.ACCOUNT_ID;
    const region = Aws.REGION;

    switch (props.sourceType) {
      case SourceType.CODECOMMIT:
      case undefined:
        if (props.createRepository) {
          this.sourceRepository = new Repository(this, 'SourceRepository', {
            description: 'Repository created using CloudMod',
            repositoryName: props.repositoryName.length ? props.repositoryName : `my-cloudmod-repo-${uniqueId()}`
          });
        } else {
          this.sourceRepository = Repository.fromRepositoryName(this, 'SourceRepository', props.repositoryName)
        }
    }

    const stackName = props.stackName ? props.stackName : Aws.STACK_NAME;

    this.buildProject = new PipelineProject(this, 'BuildProject', {
      buildSpec: BuildSpec.fromSourceFilename('buildspec.yaml'),
      environment: {
        buildImage: LinuxBuildImage.UBUNTU_14_04_NODEJS_10_1_0
      }
    });

    if (props.needsAppDelivery) {
      this.deliveryProject = new PipelineProject(this, 'DeliveryProject', {
        buildSpec: BuildSpec.fromSourceFilename('deliverspec.yaml'),
        environment: {
          buildImage: LinuxBuildImage.UBUNTU_14_04_NODEJS_10_1_0,
          environmentVariables: {
            STACK_NAME: {
              type: BuildEnvironmentVariableType.PLAINTEXT,
              value: stackName
            }
          }
        }
      });
      
      this.deliveryProject.addToRolePolicy(new PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [
          `arn:aws:cloudformation:${region}:${accountId}:stack/${stackName}`,
          `arn:aws:cloudformation:${region}:${accountId}:stack/${stackName}/*`
        ]
      }));
  
      this.deliveryProject.addToRolePolicy(new PolicyStatement({
        actions: ['s3:PutObject'],
        resources: ['*']
      }));
  
      this.deliveryProject.addToRolePolicy(new PolicyStatement({
        actions: ['iot:DescribeEndpoint'],
        resources: ['*']
      }));
    }

    // Configure source stage
    const sourceArtifact = new Artifact('SourceCode');
    let sourceAction: CodeCommitSourceAction | GitHubSourceAction;

    switch (props.sourceType) {
      case SourceType.CODECOMMIT:
      case undefined:
        sourceAction = new CodeCommitSourceAction({
          branch: props.branchName || 'master',
          repository: this.sourceRepository,
          actionName: 'CodeCommitSource',
          output: sourceArtifact
        })
        break;
      case SourceType.GITHUB:
        const oauth = Secret.fromSecretArn(this, 'GithubOAuthToken', props.oauthSecretArn!);

        sourceAction = new GitHubSourceAction({
          actionName: 'GitHubSource',
          branch: props.branchName || 'master',
          oauthToken: oauth.secretValueFromJson('github-access-token'),
          output: sourceArtifact,
          owner: props.accountOwner!,
          repo: props.repositoryName
        });
    }

    // Configure build stage
    const buildArtifact = new Artifact('InfraDefinition')

    this.pipeline = new Pipeline(this, 'CicdPipeline', {
      pipelineName: props.pipelineName,
      stages: [
        {
          stageName: 'Staging',
          actions: [
            sourceAction!
          ]
        },
        {
          stageName: 'BuildInfra',
          actions: [
            new CodeBuildAction({
              input: sourceArtifact,
              outputs: [buildArtifact],
              project: this.buildProject,
              actionName: 'InfraSynthesis'
            })
          ]
        },
        {
          stageName: 'Deploy',
          actions: [
            new CloudFormationCreateReplaceChangeSetAction({
              adminPermissions: true,
              capabilities: [CloudFormationCapabilities.ANONYMOUS_IAM],
              stackName,
              templatePath: buildArtifact.atPath('template.yaml'),
              templateConfiguration: buildArtifact.atPath('template-configuration.json'),
              actionName: 'Deploy',
              changeSetName: 'Main'
            })
          ]
        }
      ]
    });

    if (props.needsAppDelivery) {
      // Configure delivery stage
      this.pipeline.addStage({
        stageName: 'Delivery',
        actions: [
          new CodeBuildAction({
            input: sourceArtifact,
            project: this.deliveryProject,
            actionName: 'DeliverApp'
          })
        ]
      });
    }
  }
}
