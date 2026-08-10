#!/usr/bin/env npx tsx
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PlaudConfig, PlaudAuth, PlaudClient, fetchRequester } from '@plaud/core';

async function main() {
  const config = new PlaudConfig();

  // Accept either auth source: passkey tokens.json or email/password config.json.
  if (!config.getToken() && !config.getCredentials()) {
    console.error('No Plaud authentication found. Run `plaud login` first (writes ~/.plaud/tokens.json).');
    process.exit(1);
  }

  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, config, fetchRequester);

  const server = new McpServer({
    name: 'plaud-mcp',
    version: '0.1.0',
  });

  const recordingIdSchema = { recording_id: z.string().describe('The recording ID') };

  server.tool('plaud_list_recordings', 'List all Plaud recordings with ID, date, duration, and title.', async () => {
    const recs = await client.listRecordings();
    const result = recs.map(r => ({
      id: r.id,
      title: r.name,
      date: (r.start_at ?? r.created_at ?? '').slice(0, 16),
      duration_minutes: Math.round(r.duration / 60000), // duration is ms
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('plaud_get_transcript', 'Get the transcript of a Plaud recording by ID.', recordingIdSchema, async (params) => {
    const detail = await client.getRecording(params.recording_id);
    const result = { id: detail.id, title: detail.name, transcript: detail.transcriptText || 'No transcript available.' };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('plaud_get_recording_detail', 'Get full details of a Plaud recording including metadata and transcript.', recordingIdSchema, async (params) => {
    const detail = await client.getRecording(params.recording_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] };
  });

  server.tool('plaud_user_info', 'Get current Plaud user information.', async () => {
    const user = await client.getUserInfo();
    return { content: [{ type: 'text' as const, text: JSON.stringify(user, null, 2) }] };
  });

  server.tool('plaud_get_mp3_url', 'Get a temporary download URL for the MP3 version of a recording.', recordingIdSchema, async (params) => {
    const url = await client.getMp3Url(params.recording_id);
    const result = { url: url || null, message: url ? 'Temporary URL valid for a short time.' : 'No MP3 available.' };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
