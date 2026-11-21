import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serialize, deserialize } from 'node:v8';
import { createNativeFrames } from '../../session/native-transport.mjs';

class Socket extends EventEmitter {
  destroyed=false;writableLength=0;writes=[];ended=false;
  write(value){this.writes.push(value);return true;}
  end(value){if(value)this.write(value);this.ended=true;}
  pause(){}resume(){}
  destroy(){if(this.destroyed)return;this.destroyed=true;this.emit('close');}
}
const wire=value=>{const body=serialize(value),header=Buffer.alloc(4);header.writeUInt32BE(body.length);return Buffer.concat([header,body]);};

test('a fatal frame rejection is flushed once before closing and cannot reopen admission',()=>{
  const socket=new Socket();let failures=0,messages=0;
  const transport=createNativeFrames(socket,()=>{messages++;},error=>{failures++;return{type:'error',code:error.code};});
  socket.emit('data',Buffer.alloc(4));
  assert.equal(failures,1);assert.equal(socket.ended,true);assert.equal(socket.destroyed,false);
  assert.equal(socket.writes.length,1);
  assert.deepEqual(deserialize(socket.writes[0].subarray(4)),{type:'error',code:'SUPERVISOR_FRAME_LIMIT'});
  assert.equal(socket.writes[0].readUInt32BE(0),socket.writes[0].length-4);
  socket.emit('data',wire({method:'command'}));assert.equal(messages,0);assert.equal(failures,1);
  assert.throws(()=>transport.send({value:'late'}),{code:'OWNER_UNREACHABLE'});
  socket.destroy();
});

test('terminal error flushing respects the output queue bound',()=>{
  const socket=new Socket();socket.writableLength=1024;
  createNativeFrames(socket,()=>{},error=>({type:'error',code:error.code}),{maxFrame:1024,maxQueue:1024});
  socket.emit('data',Buffer.alloc(4));
  assert.equal(socket.destroyed,true);assert.equal(socket.writes.length,0);
});

test('fragmented native frames preserve exact wire values and close prevents further delivery',()=>{
  const socket=new Socket(),values=[],value={integer:9223372036854775807n,bytes:new Uint8Array([0,127,255]),args:['local-id']};
  const transport=createNativeFrames(socket,item=>values.push(item),error=>{throw error;});
  const frame=wire(value);
  for(let offset=0;offset<frame.length;offset+=3)socket.emit('data',frame.subarray(offset,offset+3));
  assert.deepEqual(values,[value]);
  transport.send(value);assert.deepEqual(deserialize(socket.writes[0].subarray(4)),value);
  transport.close();socket.emit('data',frame);assert.equal(values.length,1);socket.destroy();
});
