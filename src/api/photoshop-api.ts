import { Logger } from '../utils/logger.js';
import { PhotoshopConnection } from '../platform/connection.js';

export type APIType = 'UXP' | 'ExtendScript';

export interface PhotoshopAPI {
  /**
   * Execute a script using the appropriate API
   */
  executeScript(script: string, timeout?: number): Promise<unknown>;

  /**
   * Get the API type being used
   */
  getAPIType(): APIType;
}

export class PhotoshopAPIFactory {
  private logger: Logger;
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.logger = new Logger('PhotoshopAPIFactory');
    this.connection = connection;
  }

  async createAPI(): Promise<PhotoshopAPI> {
    const info = this.connection.getPhotoshopInfo();
    
    if (!info) {
      throw new Error('Photoshop info not available. Please detect Photoshop first.');
    }

    // Determine which API to use based on version
    const apiType = this.determineAPIType(info.version);
    
    this.logger.info(`Creating ${apiType} API for Photoshop version ${info.version}`);

    if (apiType === 'UXP') {
      return new UXPPhotoshopAPI(this.connection);
    } else {
      return new ExtendScriptPhotoshopAPI(this.connection);
    }
  }

  private determineAPIType(version: string): APIType {
    // IMPORTANT: When running scripts via AppleScript/COM, we can only use ExtendScript
    // UXP is only available for plugins, not for external script execution
    // Therefore, we always use ExtendScript for external automation
    
    this.logger.debug(`Using ExtendScript for version ${version} (UXP not available for external scripting)`);
    return 'ExtendScript';
  }
}

/**
 * UXP-based API for modern Photoshop (23.5+)
 * NOTE: UXP is not available for external script execution via AppleScript/COM
 * This class is kept for future plugin-based implementation
 */
class UXPPhotoshopAPI implements PhotoshopAPI {
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.connection = connection;
  }

  async executeScript(script: string, timeout?: number): Promise<unknown> {
    // UXP cannot be executed externally via AppleScript/COM
    // Fall back to ExtendScript
    return await this.connection.executeScript(script, timeout);
  }

  getAPIType(): APIType {
    return 'UXP';
  }
}

/**
 * ExtendScript-based API for legacy Photoshop (< 23.5)
 */
class ExtendScriptPhotoshopAPI implements PhotoshopAPI {
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.connection = connection;
  }

  async executeScript(script: string, timeout?: number): Promise<unknown> {
    // Wrap script in error handling
    const wrappedScript = this.wrapInErrorHandling(script);
    const result = await this.connection.executeScript(wrappedScript, timeout);

    if (
      result &&
      typeof result === 'object' &&
      'ok' in result &&
      typeof (result as { ok?: boolean }).ok === 'boolean'
    ) {
      const envelope = result as {
        ok: boolean;
        result?: unknown;
        error?: { message?: string };
      };

      if (!envelope.ok) {
        throw new Error(envelope.error?.message || 'Unknown Photoshop script error');
      }

      return envelope.result;
    }

    return result;
  }

  private wrapInErrorHandling(script: string): string {
    return `
(function() {
  function __psEscapeString(value) {
    return String(value)
      .replace(/\\\\/g, '\\\\\\\\')
      .replace(/"/g, '\\"')
      .replace(/\\r/g, '\\\\r')
      .replace(/\\n/g, '\\\\n')
      .replace(/\\t/g, '\\\\t')
      .replace(/\\f/g, '\\\\f')
      .replace(/\\u2028/g, '\\\\u2028')
      .replace(/\\u2029/g, '\\\\u2029');
  }

  function __psEncode(value) {
    if (value === undefined || value === null) {
      return 'null';
    }

    var valueType = typeof value;
    if (valueType === 'string') {
      return '"' + __psEscapeString(value) + '"';
    }
    if (valueType === 'number' || valueType === 'boolean') {
      return String(value);
    }
    if (value instanceof Array) {
      var parts = [];
      for (var i = 0; i < value.length; i++) {
        parts.push(__psEncode(value[i]));
      }
      return '[' + parts.join(',') + ']';
    }
    if (valueType === 'object') {
      var objectParts = [];
      for (var key in value) {
        if (value.hasOwnProperty(key)) {
          objectParts.push(__psEncode(String(key)) + ':' + __psEncode(value[key]));
        }
      }
      return '{' + objectParts.join(',') + '}';
    }

    return __psEncode(String(value));
  }

  try {
    var result = (function() {
      ${script}
    })();

    return __psEncode({
      ok: true,
      result: result === undefined ? null : result
    });
  } catch (error) {
    return __psEncode({
      ok: false,
      error: {
        message: error && error.message ? error.message : String(error)
      }
    });
  }
})();
    `.trim();
  }

  getAPIType(): APIType {
    return 'ExtendScript';
  }
}
