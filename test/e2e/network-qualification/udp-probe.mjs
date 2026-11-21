import assert from 'node:assert/strict';
import dgram from 'node:dgram';

export async function udpProbe(type, address, createSocket = dgram.createSocket) {
  let server, client;
  try {
    server = createSocket(type);
    client = createSocket(type);
    server.on('message', (bytes, remote) => server.send(bytes, remote.port, remote.address));
    await bind(server, address);
    await bind(client, address);
    return {
      async echoes() {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { client.off('message', received); resolve(false); }, 400);
          const received = bytes => { clearTimeout(timer); assert.equal(bytes.toString(), 'probe'); resolve(true); };
          client.once('message', received);
          client.send(Buffer.from('probe'), server.address().port, address, error => {
            if (error) {
              clearTimeout(timer); client.off('message', received);
              // Local OUTPUT DROP can reject sendmsg immediately instead of
              // silently timing out. It is not a successful echo.
              if (error.code === 'EPERM') resolve(false); else reject(error);
            }
          });
        });
      },
      close() { closeSockets([server, client]); },
    };
  } catch (error) {
    try { closeSockets([server, client]); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'NETWORK_LAB_UDP_CLEANUP_FAILED'); }
    throw error;
  }
}

export async function openUdpProbes(factory = udpProbe) {
  const probes = [];
  try {
    probes.push(await factory('udp4', '127.0.0.1'));
    probes.push(await factory('udp6', '::1'));
    return probes;
  } catch (error) {
    try { closeSockets(probes); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'NETWORK_LAB_UDP_CLEANUP_FAILED'); }
    throw error;
  }
}

async function bind(socket, address) {
  // Register before binding, including for injected synchronous failures.
  let listening, failed;
  try {
    await new Promise((resolve, reject) => {
      listening = resolve; failed = reject;
      socket.once('listening', listening);
      socket.once('error', failed);
      socket.bind(0, address);
    });
  } finally {
    socket.off('listening', listening);
    socket.off('error', failed);
  }
}

function closeSockets(sockets) {
  const errors = [];
  for (const socket of sockets) {
    try { socket?.close(); }
    catch (error) { if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'NETWORK_LAB_UDP_CLEANUP_FAILED');
}
