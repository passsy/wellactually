import { spawn } from 'node:child_process';

export function opener(
  platform: NodeJS.Platform,
  path: string,
): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return { command: 'open', args: [path] };
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', path] };
  }
  return { command: 'xdg-open', args: [path] };
}

/** Open without holding the evaluator process open for the launcher. */
export function openReport(
  path: string,
  report: (message: string) => void = (message) => process.stdout.write(message),
): void {
  const { command, args } = opener(process.platform, path);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', (error) => {
      report(`could not open report.html: ${String(error)}\n`);
    });
    child.unref();
  } catch (error) {
    report(`could not open report.html: ${String(error)}\n`);
  }
}
