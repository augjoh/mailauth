/* eslint no-unused-expressions:0 */
'use strict';

const chai = require('chai');
const expect = chai.expect;
const Path = require('path');

let fs = require('fs').promises;
let { RelaxedHash } = require('../../../lib/dkim/body/relaxed');

chai.config.includeStack = true;

const getBody = message => {
    message = message.toString('binary');
    let match = message.match(/\r?\n\r?\n/);
    if (match) {
        message = message.substr(match.index + match[0].length);
    }
    return Buffer.from(message, 'binary');
};

describe('DKIM RelaxedBody Tests', () => {
    it('Should calculate sha256 body hash for an empty message', async () => {
        const message = Buffer.from('\r\n\r\n\n\r\n\r\n');

        let s = new RelaxedHash('rsa-sha256');
        s.update(message);

        expect(s.digest('base64')).to.equal('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    });

    it('Should calculate sha1 body hash for an empty message', async () => {
        const message = Buffer.from('\r\n\r\n\n\r\n\r\n');

        let s = new RelaxedHash('rsa-sha1');
        s.update(message);

        expect(s.digest('base64')).to.equal('2jmj7l5rSw0yVb/vlWAYkK/YBwk=');
    });

    it('Should calculate body hash byte by byte', async () => {
        let message = await fs.readFile(__dirname + '/../../fixtures/message1.eml');
        message = getBody(message);

        let s = new RelaxedHash('rsa-sha256');
        for (let i = 0; i < message.length; i++) {
            s.update(Buffer.from([message[i]]));
        }

        expect(s.digest('base64')).to.equal('D2H5TEwtUgM2u8Ew0gG6vnt/Na6L+Zep7apmSmfy8IQ=');
    });

    it('Should calculate body hash all at once', async () => {
        let message = await fs.readFile(__dirname + '/../../fixtures/message1.eml');
        message = getBody(message);

        let s = new RelaxedHash('rsa-sha256');
        s.update(message);

        expect(s.digest('base64')).to.equal('D2H5TEwtUgM2u8Ew0gG6vnt/Na6L+Zep7apmSmfy8IQ=');
    });

    it('Should calculate sha1 body hash for an empty message', async () => {
        const message = await fs.readFile(Path.join(__dirname, '..', '..', 'fixtures', 'end-space.eml'));

        let s = new RelaxedHash('rsa-sha256');
        s.update(message);

        expect(s.digest('base64')).to.equal('Vxfz30FKdOmO1/hbIhudOeTt+gvue8V4ERWVBgJ/0Nk=');
    });
});
