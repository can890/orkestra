import { describe, expect, it } from 'vitest';
import {
  MCP_APP_MAX_HTML_BYTES,
  MCP_APP_MIME_TYPE,
  MCP_CALL_MAX_RESULT_BYTES,
  clampMcpAppHeight,
  extractMcpCall,
  injectMcpAppCsp,
  mcpAppAllowAttribute,
  mcpAppContentSecurityPolicy,
  mcpAppToolCallableByApp,
  mcpAppToolResourceUri,
  mcpServerNameMatches,
  mcpToolIsReadOnly,
  mergeMcpCall,
  normalizeMcpCallResult,
  readMcpAppCsp,
  readMcpAppDocument,
  readMcpAppPermissions,
} from './mcp-app';

describe('extractMcpCall', () => {
  it('reads codex-acp MCP calls from the wrapped raw input and output', () => {
    expect(
      extractMcpCall({
        title: 'mcp.weather.get_forecast',
        rawInput: { server: 'weather', tool: 'get_forecast', arguments: { city: 'Oslo' } },
        rawOutput: {
          result: { content: [{ type: 'text', text: 'Sunny' }], structuredContent: { t: 21 } },
          error: null,
        },
        _meta: { is_mcp_tool_call: true },
      })
    ).toEqual({
      server: 'weather',
      tool: 'get_forecast',
      input: { city: 'Oslo' },
      result: { content: [{ type: 'text', text: 'Sunny' }], structuredContent: { t: 21 } },
    });
  });

  it('turns a codex-acp MCP error into an error result', () => {
    expect(
      extractMcpCall({
        rawInput: { server: 'weather', tool: 'get_forecast', arguments: {} },
        rawOutput: { result: null, error: { message: 'boom' } },
        _meta: { is_mcp_tool_call: true },
      })?.result
    ).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
  });

  it('reads claude-agent-acp MCP calls from the claudeCode tool name', () => {
    expect(
      extractMcpCall({
        title: 'get_forecast',
        rawInput: { city: 'Oslo' },
        rawOutput: [{ type: 'text', text: 'Sunny' }],
        status: 'completed',
        _meta: { claudeCode: { toolName: 'mcp__weather-app__get_forecast' } },
      })
    ).toEqual({
      server: 'weather-app',
      tool: 'get_forecast',
      input: { city: 'Oslo' },
      result: { content: [{ type: 'text', text: 'Sunny' }] },
    });
  });

  it('marks a failed claude result as an error', () => {
    expect(
      extractMcpCall({
        status: 'failed',
        rawOutput: 'denied',
        _meta: { claudeCode: { toolName: 'mcp__weather__get_forecast' } },
      })?.result
    ).toEqual({ content: [{ type: 'text', text: 'denied' }], isError: true });
  });

  it('falls back to a prefixed title for other providers', () => {
    expect(extractMcpCall({ title: 'mcp__docs__search', rawInput: { q: 'x' } })).toEqual({
      server: 'docs',
      tool: 'search',
      input: { q: 'x' },
    });
  });

  it('ignores non-MCP tools and keeps their input out of the transcript', () => {
    expect(extractMcpCall({ title: 'Bash', rawInput: { command: 'ls' } })).toBeUndefined();
    expect(
      extractMcpCall({ title: 'Read', _meta: { claudeCode: { toolName: 'Read' } }, rawInput: {} })
    ).toBeUndefined();
    // codex dynamic tools carry `{ arguments }` without a server.
    expect(extractMcpCall({ title: 'x', rawInput: { arguments: {} } })).toBeUndefined();
  });

  it("ignores Orkestra's own tool servers", () => {
    expect(
      extractMcpCall({
        _meta: { claudeCode: { toolName: 'mcp__orkestra-browser__snapshot' } },
        rawInput: {},
      })
    ).toBeUndefined();
    expect(
      extractMcpCall({
        rawInput: { server: 'orkestra', tool: 'run_subagent', arguments: {} },
        _meta: { is_mcp_tool_call: true },
      })
    ).toBeUndefined();
  });

  it('drops oversized results but keeps the identity', () => {
    const big = 'x'.repeat(MCP_CALL_MAX_RESULT_BYTES + 10);
    const call = extractMcpCall({
      _meta: { claudeCode: { toolName: 'mcp__weather__get' } },
      rawInput: { a: 1 },
      rawOutput: [{ type: 'text', text: big }],
    });
    expect(call).toEqual({ server: 'weather', tool: 'get', input: { a: 1 } });
  });
});

describe('mergeMcpCall', () => {
  it('keeps the first identity and fills in later input and result', () => {
    const first = mergeMcpCall(undefined, { server: 's', tool: 't', input: { a: 1 } });
    const done = mergeMcpCall(first, {
      server: 's',
      tool: 't',
      result: { content: [] },
    });
    expect(done).toEqual({ server: 's', tool: 't', input: { a: 1 }, result: { content: [] } });
  });

  it('ignores patches without an identity when nothing is known yet', () => {
    expect(mergeMcpCall(undefined, { result: { content: [] } })).toBeUndefined();
  });
});

describe('normalizeMcpCallResult', () => {
  it('returns undefined for unknown shapes', () => {
    expect(normalizeMcpCallResult(42)).toBeUndefined();
    expect(normalizeMcpCallResult({ foo: 1 })).toBeUndefined();
  });
});

describe('CSP construction', () => {
  it('blocks the network and external resources by default', () => {
    const policy = mcpAppContentSecurityPolicy(undefined);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).not.toContain('self');
  });

  it('opens only the declared domains', () => {
    const policy = mcpAppContentSecurityPolicy({
      connectDomains: ['https://api.example.com'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: ['https://embed.example.com'],
    });
    expect(policy).toContain('connect-src https://api.example.com');
    expect(policy).toContain("script-src 'unsafe-inline' https://cdn.example.com");
    expect(policy).toContain('img-src data: blob: https://cdn.example.com');
    expect(policy).toContain('frame-src blob: https://embed.example.com');
  });

  it('rejects values that would widen the policy', () => {
    expect(
      readMcpAppCsp({
        connectDomains: [
          '*',
          "'self'",
          'https://ok.example.com',
          'https://evil.example.com; script-src *',
          'javascript:alert(1)',
          'https://*.example.com',
          42,
        ],
      })
    ).toEqual({ connectDomains: ['https://ok.example.com', 'https://*.example.com'] });
    // A tampered stored CSP is validated again when the policy is built.
    const policy = mcpAppContentSecurityPolicy({ connectDomains: ['*'] });
    expect(policy).toContain("connect-src 'none'");
  });

  it('places the CSP meta before any app markup', () => {
    const html = injectMcpAppCsp('<!DOCTYPE html><html><script>x()</script></html>', undefined);
    expect(html.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    const bare = injectMcpAppCsp('<script>x()</script>', undefined);
    expect(bare.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it('maps permissions to the iframe allow attribute', () => {
    expect(mcpAppAllowAttribute(readMcpAppPermissions({ camera: {}, clipboardWrite: {} }))).toBe(
      'camera; clipboard-write'
    );
    expect(mcpAppAllowAttribute(readMcpAppPermissions({ usb: {} }))).toBe('');
  });
});

describe('tool metadata', () => {
  it('reads the ui resource uri', () => {
    expect(mcpAppToolResourceUri({ ui: { resourceUri: 'ui://w/app' } })).toBe('ui://w/app');
    expect(mcpAppToolResourceUri({ 'ui/resourceUri': 'ui://w/old' })).toBe('ui://w/old');
    expect(mcpAppToolResourceUri({ ui: { resourceUri: 'https://x' } })).toBeUndefined();
  });

  it('respects visibility and read-only hints', () => {
    expect(mcpAppToolCallableByApp(undefined)).toBe(true);
    expect(mcpAppToolCallableByApp({ ui: { visibility: ['model'] } })).toBe(false);
    expect(mcpAppToolCallableByApp({ ui: { visibility: ['model', 'app'] } })).toBe(true);
    expect(mcpToolIsReadOnly({ annotations: { readOnlyHint: true } })).toBe(true);
    expect(mcpToolIsReadOnly({ annotations: { readOnlyHint: 'yes' } })).toBe(false);
  });

  it('matches Claude Code server name rewriting', () => {
    expect(mcpServerNameMatches('weather', 'weather')).toBe(true);
    expect(mcpServerNameMatches('my weather.app', 'my_weather_app')).toBe(true);
    expect(mcpServerNameMatches('claude.ai Weather', 'claude_ai_Weather')).toBe(true);
    expect(mcpServerNameMatches('weather', 'weathers')).toBe(false);
  });
});

describe('readMcpAppDocument', () => {
  it('picks the mcp-app html for the requested uri', () => {
    expect(
      readMcpAppDocument(
        [
          { uri: 'ui://other', mimeType: MCP_APP_MIME_TYPE, text: '<p>no</p>' },
          {
            uri: 'ui://app',
            mimeType: 'text/html; profile=mcp-app',
            text: '<p>yes</p>',
            _meta: { ui: { prefersBorder: true } },
          },
        ],
        'ui://app'
      )
    ).toEqual({ html: '<p>yes</p>', meta: { prefersBorder: true } });
  });

  it('decodes base64 blobs and rejects oversized documents', () => {
    const blob = btoa('<p>ok</p>');
    expect(readMcpAppDocument([{ mimeType: MCP_APP_MIME_TYPE, blob }], 'ui://a')?.html).toBe(
      '<p>ok</p>'
    );
    expect(
      readMcpAppDocument(
        [{ mimeType: MCP_APP_MIME_TYPE, text: 'x'.repeat(MCP_APP_MAX_HTML_BYTES + 1) }],
        'ui://a'
      )
    ).toEqual({ html: null, meta: undefined });
    expect(readMcpAppDocument([{ mimeType: 'text/html', text: '<p>' }], 'ui://a')).toBeUndefined();
  });
});

describe('clampMcpAppHeight', () => {
  it('clamps and defaults', () => {
    expect(clampMcpAppHeight(10)).toBe(80);
    expect(clampMcpAppHeight(99999)).toBe(2000);
    expect(clampMcpAppHeight(Number.NaN)).toBe(320);
  });
});
