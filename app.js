#!/usr/bin/env node
'use strict';

const express = require('express');
const formidable = require('formidable');
const { join, basename } = require('path');
const fs = require('fs-extra');
const util = require('util');
const morgan = require('morgan');
const asyncHandler = require('express-async-handler');
const archiver = require('archiver');
const pMap = require('p-map');
const os = require('os');
const flatMap = require('lodash/flatMap');
const contentDisposition = require('content-disposition');
const { createProxyMiddleware } = require('http-proxy-middleware');
const qrcode = require('qrcode-terminal');

const isPkg = !!process.pkg;

const maxFields = 1000;
const debug = false;

const isDirectory = async (filePath) => (await fs.lstat(filePath)).isDirectory();

module.exports = ({ sharedPath: sharedPathIn, port, maxUploadSize, zipCompressionLevel }) => {
  // console.log({ sharedPath: sharedPathIn, port, maxUploadSize, zipCompressionLevel });
  const sharedPath = sharedPathIn || process.cwd();

  function getFilePath(relPath) {
    if (relPath == null) return sharedPath;
    return join(sharedPath, join('/', relPath));
  }

  const app = express();

  if (debug) app.use(morgan('dev'));

  // NOTE: Must support non latin characters
  app.post('/api/upload', asyncHandler(async (req, res) => {
    // parse a file upload
    var form = new formidable.IncomingForm();
    form.uploadDir = sharedPath;
    form.keepExtensions = true;
    form.maxFileSize = maxUploadSize;
    form.maxFields = maxFields;
  
    form.parse(req, function(err, fields, files) {
      if (err) {
        console.error('Upload failed', err);
        res.send('Upload failed');
        return;
      }
  
      console.log(util.inspect({ fields: fields, files: files }));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`Upload finished! <a href="/">Back</a>`);
    });
  }));

  async function serveDirZip(filePath, res) {
    const archive = archiver('zip', {
      zlib: { level: zipCompressionLevel },
    });
  
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      // NOTE: Must support non latin characters
      'Content-disposition': contentDisposition(`${basename(filePath)}.zip`),
    });
    archive.pipe(res);
  
    archive.directory(filePath, basename(filePath));
    archive.finalize();
    // res.end();
  }

  app.get('/api/download', asyncHandler(async (req, res) => {
    const filePath = getFilePath(req.query.f);
    const isDir = await isDirectory(filePath);
  
    if (isDir) {
      await serveDirZip(filePath, res);
    } else {
      // NOTE: Must support non latin characters
      res.set('Content-disposition', contentDisposition(basename(filePath)));
      fs.createReadStream(filePath).pipe(res);
    }
  }));

  app.get('/api/browse', asyncHandler(async (req, res) => {
    const curRelPath = req.query.p || '/';
    const curAbsPath = getFilePath(curRelPath);

    const readdirEntries = await fs.readdir(curAbsPath);

    const ret = (await pMap(readdirEntries, async (entry) => {
      const fileAbsPath = join(curAbsPath, entry); // TODO what if a file called ".."
      const fileRelPath = join(curRelPath, entry);
      const isDir = await isDirectory(fileAbsPath);

      return {
        path: fileRelPath,
        isDir,
        fileName: entry,
      };
    }, { concurrency: 10 }));

    res.send({
      files: [
        { path: join(curRelPath, '..'), fileName: '..', isDir: true },
        ...ret
      ],
      curRelPath,
      sharedPath,
    });
  }));

  console.log(`Sharing path ${sharedPath}`);

  app.listen(port, () => {
    const interfaces = os.networkInterfaces();
    const urls = flatMap(Object.values(interfaces), (addresses) => addresses).filter(({ family, address }) => family === 'IPv4' && address !== '127.0.0.1').map(({ address }) => `http://${address}:${port}/`);
    if (urls.length === 0) return;
    console.log('Server listening on:');
    urls.forEach((url) => {
      console.log(url);
      console.log();
      qrcode.generate(url);
    });
  });

  // Serving the frontend depending on dev/production
  if (isPkg) app.use('/', express.static(join(__dirname, 'ezshare-frontend/build')));
  else app.use('/', createProxyMiddleware({ target: 'http://localhost:3000', ws: true }));

  // Default to index because SPA
  app.use('*', (req, res) => res.sendFile(join(__dirname, 'ezshare-frontend/build/index.html')));  
};