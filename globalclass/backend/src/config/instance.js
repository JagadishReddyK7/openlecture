// Identity of this core-api process, used for Redis state that must be
// attributed to one instance: which sockets it holds (Q&A presence) and
// whether it holds a lecture's broadcast lease. The hostname is the container
// id under Docker, which makes it easy to match against `docker ps`.
import os from 'os';
import crypto from 'crypto';

export const instanceId = `${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`;
