import type {
  GetPromptResult,
  ListPromptsResult,
  Prompt,
  PromptMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { Session } from '../core/session.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopStateService } from '../state/state-service.js';

const PROMPTS: Prompt[] = [
  {
    name: 'analyze-current-doc',
    title: 'Analyze Current Doc',
    description: 'Inspect the current Photoshop document and suggest editing opportunities.',
  },
  {
    name: 'prepare-for-edit',
    title: 'Prepare For Edit',
    description: 'Summarize current state and propose a safe sequence before editing.',
    arguments: [
      {
        name: 'goal',
        description: 'Short description of the intended edit goal.',
        required: false,
      },
    ],
  },
  {
    name: 'recover-from-dialog',
    title: 'Recover From Dialog',
    description: 'Help an agent reason through a blocking Photoshop dialog or modal state.',
  },
  {
    name: 'build-social-post',
    title: 'Build Social Post',
    description: 'Prepare a Photoshop editing plan for a social media asset.',
    arguments: [
      {
        name: 'platform',
        description: 'Target social platform, for example instagram or linkedin.',
        required: false,
      },
    ],
  },
];

export class PhotoshopPromptProvider {
  private readonly state: PhotoshopStateService;
  private readonly session: Session;

  constructor(connection: PhotoshopConnection, session: Session) {
    this.state = new PhotoshopStateService(connection, session);
    this.session = session;
  }

  async list(): Promise<ListPromptsResult> {
    return {
      prompts: PROMPTS,
    };
  }

  async get(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    const state = await this.state.getActiveContext('normal');
    const lastError = this.session.getLastError();
    const messages: PromptMessage[] = [];

    switch (name) {
      case 'analyze-current-doc':
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `Analyze the current Photoshop document using this state snapshot:\n${JSON.stringify(state, null, 2)}\nFocus on structure, editable targets, and the safest next actions.`,
          },
        });
        break;
      case 'prepare-for-edit':
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `Prepare for a Photoshop edit.\nGoal: ${args?.goal || 'No explicit goal provided.'}\nCurrent context:\n${JSON.stringify(state, null, 2)}\nSuggest a short, reliable tool sequence with checkpoints when useful.`,
          },
        });
        break;
      case 'recover-from-dialog':
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `A Photoshop interaction appears blocked by UI state.\nCurrent context:\n${JSON.stringify(state, null, 2)}\nSession last error: ${JSON.stringify(lastError, null, 2)}\nSuggest the fastest safe recovery path using UI fallback tools.`,
          },
        });
        break;
      case 'build-social-post':
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `Plan a Photoshop workflow for a social media creative.\nPlatform: ${args?.platform || 'unspecified'}\nCurrent context:\n${JSON.stringify(state, null, 2)}\nRecommend canvas, typography, export, and verification steps.`,
          },
        });
        break;
      default:
        throw new Error(`Unknown prompt: ${name}`);
    }

    return {
      description: PROMPTS.find((prompt) => prompt.name === name)?.description,
      messages,
    };
  }
}
