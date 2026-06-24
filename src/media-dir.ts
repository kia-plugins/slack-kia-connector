import path from 'node:path';

/** Slack file-attachment cache dir under the host-provided shared data root.
 *  The connector namespaces under its own id so connectors never collide.
 *  Files are content-addressed: the on-disk filename IS the sha256 of bytes. */
export function mediaDir(dataRoot: string): string {
  return path.join(dataRoot, 'slack', 'media');
}
