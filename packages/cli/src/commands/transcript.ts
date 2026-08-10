import { PlaudConfig, PlaudAuth, PlaudClient, fetchRequester } from '@plaud/core';

export async function transcriptCommand(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: plaud transcript <recording-id>');
    process.exit(1);
  }

  const config = new PlaudConfig();
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, config, fetchRequester);

  const detail = await client.getRecording(id);

  if (detail.transcriptText && detail.transcriptText.length > 0) {
    console.log(detail.transcriptText);
  } else {
    console.log('No transcript available for this recording.');
  }
}
