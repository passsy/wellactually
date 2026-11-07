/** Install the built read-only connector without changing Code's plugin config. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(os.homedir(), '.well-actually', 'desktop-reader');
const config = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json')
  : process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Claude/claude_desktop_config.json')
    : null;
if (!config) throw new Error('Configure desktop-mcp manually on this platform; see docs/desktop-reader.md.');
const original = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '{}';
const settings = JSON.parse(original);
fs.mkdirSync(destination, {recursive:true});
fs.copyFileSync(path.join(root,'dist/wellactually.mjs'),path.join(destination,'wellactually.mjs'));
fs.cpSync(path.join(root,'dist/web'),path.join(destination,'web'),{recursive:true});
settings.mcpServers ??= {};
settings.mcpServers['wellactually-reader'] = {
  command: process.execPath,
  args: [path.join(destination,'wellactually.mjs'),'desktop-mcp'],
  env: {WELLACTUALLY_REVIEW_HOST:'claude'},
};
fs.mkdirSync(path.dirname(config),{recursive:true});
const backup = `${config}.before-wellactually-reader-${Date.now()}.bak`;
fs.writeFileSync(backup,original,{mode:0o600});
const temp = `${config}.${process.pid}.tmp`;
fs.writeFileSync(temp,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
fs.renameSync(temp,config);
console.log(`Installed read-only review connector in ${destination}. Restart Claude Desktop, then ask Claude Chat to list reviews and show a review_status card.\nConfiguration backup: ${backup}`);
