import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,gunzipSync} from 'node:zlib';
import {mkdtempSync,mkdirSync,symlinkSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packTarGz,unpackTarGz} from '../../contract/archive.mjs';
import {extractVerifiedTarGz} from '../../contract/release-verify.mjs';

function changedHeader(change) {
  const tar=gunzipSync(packTarGz([{path:'safe.txt',bytes:'payload'}]));
  change(tar);
  tar.fill(32,148,156);
  let sum=0;for(const byte of tar.subarray(0,512))sum+=byte;
  tar.write(sum.toString(8).padStart(6,'0')+'\0 ',148,'ascii');
  return gzipSync(tar);
}

test('tar rejects malformed sizes, incomplete bodies/trailers, absolute paths and link entries disguised as directories',()=>{
  for(const value of ['-0000000001','0000000008x'])
    assert.throws(()=>unpackTarGz(changedHeader(tar=>tar.write(value+'\0',124,'ascii'))),{code:'ARCHIVE_CORRUPT'});
  const tar=gunzipSync(packTarGz([{path:'safe.txt',bytes:'payload'}]));
  for(const length of [513,1024,1536])assert.throws(()=>unpackTarGz(gzipSync(tar.subarray(0,length))),{code:'ARCHIVE_CORRUPT'});
  for(const name of ['/escape','C:/escape','C:\\escape','../escape']){
    assert.throws(()=>packTarGz([{path:name,bytes:'bad'}]),{code:'ARCHIVE_PATH_UNSAFE'});
    assert.throws(()=>unpackTarGz(changedHeader(tar=>{tar.fill(0,0,100);tar.write(name,0);})),{code:'ARCHIVE_PATH_UNSAFE'});
  }
  assert.throws(()=>unpackTarGz(changedHeader(tar=>{tar.fill(0,0,100);tar.write('link/',0);tar[156]=50;})),{code:'ARCHIVE_UNSUPPORTED_ENTRY'});
});

test('tar counts directory/header floods and rejects duplicate files and oversized output',()=>{
  const archive=packTarGz([{path:'one',bytes:'1'},{path:'two',bytes:'22'}]);
  assert.throws(()=>unpackTarGz(archive,{maxEntries:1}),{code:'ARCHIVE_ENTRY_LIMIT'});
  assert.throws(()=>unpackTarGz(archive,{maxTotalBytes:2}),{code:'ARCHIVE_SIZE_LIMIT'});
  assert.throws(()=>unpackTarGz(packTarGz([{path:'one',bytes:'1'},{path:'one',bytes:'2'}])),{code:'ARCHIVE_DUPLICATE_ENTRY'});
});

test('verified extraction refuses existing directory and target symlinks without changing outside files',t=>{
  const root=mkdtempSync(join(tmpdir(),'archive-links-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const outside=join(root,'outside'),target=join(root,'target');mkdirSync(outside);mkdirSync(target);
  writeFileSync(join(outside,'file'),'original');
  symlinkSync(outside,join(target,'nested'),'dir');
  assert.throws(()=>extractVerifiedTarGz(packTarGz([{path:'nested/file',bytes:'bad'}]),target),{code:'ARCHIVE_PATH_UNSAFE'});
  symlinkSync(join(outside,'file'),join(target,'file'));
  assert.throws(()=>extractVerifiedTarGz(packTarGz([{path:'file',bytes:'bad'}]),target),{code:'ARCHIVE_PATH_UNSAFE'});
  assert.equal(readFileSync(join(outside,'file'),'utf8'),'original');
});

test('release downloads validate expectations before fetching and keep retained artifact bounds separate from metadata',async()=>{
  const {createReleaseDownloader,RELEASE_DOWNLOAD_LIMITS}=await import('../../contract/release-verify.mjs');
  let calls=0;
  const downloader=createReleaseDownloader('https://github.com/werg/tendriller/releases/download/source-'+'a'.repeat(40),{
    limits:{...RELEASE_DOWNLOAD_LIMITS,metadataBytes:2,artifactBytes:8,totalBytes:16,artifacts:2},
    fetcher:async()=>{calls++;return new Response('12345678');},
  });
  for(const file of ['../secret','https://other.test/file','file?redirect=1'])
    await assert.rejects(downloader.download(file),{code:'release_expectation_invalid'});
  await assert.rejects(downloader.download('kit.tgz','bad'),{code:'release_expectation_invalid'});
  await assert.rejects(downloader.download('kit.tgz',undefined,-1),{code:'release_expectation_invalid'});
  assert.equal(calls,0);
  assert.equal((await downloader.download('kit.tgz',undefined,8,true)).length,8);
  await assert.rejects(downloader.download('manifest.json',undefined,undefined,true),{code:'release_size_limit'});
  await assert.rejects(downloader.download('extra.tgz'),{code:'release_size_limit'});
  assert.equal(calls,2);
});
