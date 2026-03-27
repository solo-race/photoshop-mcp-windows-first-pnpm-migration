import type {
  ListResourcesResult,
  ReadResourceResult,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import { Session } from '../core/session.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { WindowsUIController } from '../platform/windows-ui.js';
import { PhotoshopStateService } from '../state/state-service.js';

const RESOURCES: Resource[] = [
  {
    uri: 'photoshop://state',
    name: 'photoshop-state',
    title: 'Photoshop State',
    description: 'Structured Photoshop application and active document state.',
    mimeType: 'application/json',
  },
  {
    uri: 'photoshop://documents',
    name: 'photoshop-documents',
    title: 'Open Documents',
    description: 'Structured list of open Photoshop documents.',
    mimeType: 'application/json',
  },
  {
    uri: 'photoshop://layers',
    name: 'photoshop-layers',
    title: 'Layer Tree',
    description: 'Layer tree for the active Photoshop document.',
    mimeType: 'application/json',
  },
  {
    uri: 'photoshop://history',
    name: 'photoshop-history',
    title: 'History State',
    description: 'History summary for the active Photoshop document.',
    mimeType: 'application/json',
  },
  {
    uri: 'photoshop://ui',
    name: 'photoshop-ui',
    title: 'Photoshop UI',
    description: 'Windows UI automation snapshot for Photoshop.',
    mimeType: 'application/json',
  },
];

export class PhotoshopResourceProvider {
  private readonly state: PhotoshopStateService;
  private readonly windowsUi = new WindowsUIController();

  constructor(connection: PhotoshopConnection, session: Session) {
    this.state = new PhotoshopStateService(connection, session);
  }

  async list(): Promise<ListResourcesResult> {
    return {
      resources: RESOURCES,
    };
  }

  async read(uri: string): Promise<ReadResourceResult> {
    let payload: Record<string, unknown>;

    switch (uri) {
      case 'photoshop://state':
        payload = await this.state.getState('full');
        break;
      case 'photoshop://documents':
        payload = await this.state.getOpenDocuments('full');
        break;
      case 'photoshop://layers':
        payload = await this.state.getLayerTree({ by: 'active' }, 'full');
        break;
      case 'photoshop://history':
        payload = await this.state.getHistory({ by: 'active' }, 'full');
        break;
      case 'photoshop://ui':
        payload = await this.windowsUi.getUiSnapshot();
        break;
      default:
        throw new Error(`Unknown resource URI: ${uri}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }
}
