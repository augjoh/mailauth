/* eslint no-control-regex: 0 */

'use strict';

const punycode = require('punycode/');
const libmime = require('libmime');
const dns = require('dns').promises;
const crypto = require('crypto');
const https = require('https');
const packageData = require('../package');
const parseDkimHeaders = require('./parse-dkim-headers');
const psl = require('psl');
const { Certificate } = require('@fidm/x509');
const zlib = require('zlib');
const util = require('util');
const gunzip = util.promisify(zlib.gunzip);

const defaultDKIMFieldNames =
    'From:Sender:Reply-To:Subject:Date:Message-ID:To:' +
    'Cc:MIME-Version:Content-Type:Content-Transfer-Encoding:Content-ID:' +
    'Content-Description:Resent-Date:Resent-From:Resent-Sender:' +
    'Resent-To:Resent-Cc:Resent-Message-ID:In-Reply-To:References:' +
    'List-Id:List-Help:List-Unsubscribe:List-Subscribe:List-Post:' +
    'List-Owner:List-Archive:BIMI-Selector';

const defaultARCFieldNames = `DKIM-Signature:Delivered-To:${defaultDKIMFieldNames}`;
const defaultASFieldNames = `ARC-Authentication-Results:ARC-Message-Signature:ARC-Seal`;

const keyOrderingDKIM = ['v', 'a', 'c', 'd', 'h', 'i', 'l', 'q', 's', 't', 'x', 'z', 'bh', 'b'];
const keyOrderingARC = ['i', 'a', 'c', 'd', 'h', 'l', 'q', 's', 't', 'x', 'z', 'bh', 'b'];
const keyOrderingAS = ['i', 'a', 't', 'cv', 'd', 's', 'b'];

const writeToStream = async (stream, input, chunkSize) => {
    chunkSize = chunkSize || 64 * 1024;

    if (typeof input === 'string') {
        input = Buffer.from(input);
    }

    return new Promise((resolve, reject) => {
        if (typeof input.on === 'function') {
            // pipe as stream
            input.pipe(stream);
            input.on('error', reject);
        } else {
            let pos = 0;
            let writeChunk = () => {
                if (pos >= input.length) {
                    return stream.end();
                }

                let chunk;
                if (pos + chunkSize >= input.length) {
                    chunk = input.slice(pos);
                } else {
                    chunk = input.slice(pos, pos + chunkSize);
                }
                pos += chunk.length;

                if (stream.write(chunk) === false) {
                    stream.once('drain', () => writeChunk());
                    return;
                }
                setImmediate(writeChunk);
            };
            setImmediate(writeChunk);
        }

        stream.on('end', resolve);
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
};

const parseHeaders = buf => {
    let rows = buf
        .toString('binary')
        .replace(/[\r\n]+$/, '')
        .split(/\r?\n/)
        .map(row => [row]);
    for (let i = rows.length - 1; i >= 0; i--) {
        if (i > 0 && /^\s/.test(rows[i][0])) {
            rows[i - 1] = rows[i - 1].concat(rows[i]);
            rows.splice(i, 1);
        }
    }

    rows = rows.map(row => {
        row = row.join('\r\n');
        let key = row.match(/^[^:]+/);
        let casedKey;
        if (key) {
            casedKey = key[0].trim();
            key = casedKey.toLowerCase();
        }

        return { key, casedKey, line: Buffer.from(row, 'binary') };
    });

    return { parsed: rows, original: buf };
};

const getSigningHeaderLines = (parsedHeaders, fieldNames, verify) => {
    fieldNames = (typeof fieldNames === 'string' ? fieldNames : defaultDKIMFieldNames)
        .split(':')
        .map(key => key.trim().toLowerCase())
        .filter(key => key);

    let signingList = [];

    if (verify) {
        let parsedList = [].concat(parsedHeaders);
        for (let fieldName of fieldNames) {
            for (let i = parsedList.length - 1; i >= 0; i--) {
                let header = parsedList[i];
                if (fieldName === header.key) {
                    signingList.push(header);
                    parsedList.splice(i, 1);
                    break;
                }
            }
        }
    } else {
        for (let i = parsedHeaders.length - 1; i >= 0; i--) {
            let header = parsedHeaders[i];
            if (fieldNames.includes(header.key)) {
                signingList.push(header);
            }
        }
    }

    return {
        keys: signingList.map(entry => entry.casedKey).join(': '),
        headers: signingList
    };
};

/**
 * Generates `DKIM-Signature: ...` header for selected values
 * @param {Object} values
 */
const formatSignatureHeaderLine = (type, values, folded) => {
    type = (type || '').toString().toUpperCase();

    let keyOrdering, headerKey;
    switch (type) {
        case 'DKIM':
            headerKey = 'DKIM-Signature';
            keyOrdering = keyOrderingDKIM;
            values = Object.assign(
                {
                    v: 1,
                    t: Math.round(Date.now() / 1000),
                    q: 'dns/txt'
                },
                values
            );
            break;

        case 'ARC':
            headerKey = 'ARC-Message-Signature';
            keyOrdering = keyOrderingARC;
            values = Object.assign(
                {
                    t: Math.round(Date.now() / 1000),
                    q: 'dns/txt'
                },
                values
            );
            break;

        case 'AS':
            headerKey = 'ARC-Seal';
            keyOrdering = keyOrderingAS;
            values = Object.assign(
                {
                    t: Math.round(Date.now() / 1000)
                },
                values
            );
            break;

        default:
            throw new Error('Unknown Signature type');
    }

    const header =
        `${headerKey}: ` +
        Object.keys(values)
            .filter(key => values[key] !== false && typeof values[key] !== 'undefined' && values.key !== null && keyOrdering.includes(key))
            .sort((a, b) => keyOrdering.indexOf(a) - keyOrdering.indexOf(b))
            .map(key => {
                let val = values[key] || '';
                if (key === 'b' && folded && val) {
                    // fold signature value
                    return `${key}=${val}`.replace(/.{75}/g, '$& ').trim();
                }

                if (['d', 's'].includes(key)) {
                    try {
                        // convert to A-label if needed
                        val = punycode.toASCII(val);
                    } catch (err) {
                        // ignore
                    }
                }

                if (key === 'i' && type === 'DKIM') {
                    let atPos = val.indexOf('@');
                    if (atPos >= 0) {
                        let domainPart = val.substr(atPos + 1);
                        try {
                            // convert to A-label if needed
                            domainPart = punycode.toASCII(domainPart);
                        } catch (err) {
                            // ignore
                        }
                        val = val.substr(0, atPos + 1) + domainPart;
                    }
                }

                return `${key}=${val}`;
            })
            .join('; ');

    if (folded) {
        return libmime.foldLines(header);
    }

    return header;
};

const getPublicKey = async (type, name, minBitLength, resolver) => {
    minBitLength = minBitLength || 1024;
    resolver = resolver || dns.resolve;

    let list = await resolver(name, 'TXT');
    let rr =
        list &&
        []
            .concat(list[0] || [])
            .join('')
            .replace(/\s+/g, '');

    if (rr) {
        // prefix value for parsing as there is no default value
        let entry = parseDkimHeaders(`DNS: TXT;${rr}`);

        let publicKey = entry?.parsed?.p?.value;
        if (!publicKey) {
            let err = new Error('Missing key value');
            err.code = 'EINVALIDVAL';
            err.rr = rr;
            throw err;
        }

        if (type === 'DKIM' && entry?.parsed?.v && (entry?.parsed?.v?.value || '').toString().toLowerCase().trim() !== 'dkim1') {
            let err = new Error('Unknown key version');
            err.code = 'EINVALIDVER';
            err.rr = rr;
            throw err;
        }

        publicKeyPem = Buffer.from(`-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`);
        publicKey = crypto.createPublicKey({ key: publicKeyPem, format: 'pem' });
        let keyType = publicKey.asymmetricKeyType;

        if (!['rsa', 'ed25519'].includes(keyType) || (entry?.parsed?.k && entry?.parsed?.k?.value?.toLowerCase() !== keyType)) {
            let err = new Error('Unknown key type');
            err.code = 'EINVALIDTYPE';
            err.rr = rr;
            throw err;
        }

        if (keyType === 'rsa') {
            // check key length
            if (publicKey.modulusLength < 1024) {
                let err = new Error('Key too short');
                err.code = 'ESHORTKEY';
                err.rr = rr;
                throw err;
            }
        }

        return { publicKey: publicKeyPem, rr };
    }

    let err = new Error('Missing key value');
    err.code = 'EINVALIDVAL';
    throw err;
};

const fetch = url =>
    new Promise((resolve, reject) => {
        https
            .get(
                url,
                {
                    headers: {
                        'User-Agent': `mailauth/${packageData.version} (+${packageData.homepage}`
                    }
                },
                res => {
                    let chunks = [];
                    let chunklen = 0;
                    res.on('readable', () => {
                        let chunk;
                        while ((chunk = res.read()) !== null) {
                            chunks.push(chunk);
                            chunklen += chunk.length;
                        }
                    });

                    res.on('end', () => {
                        resolve({
                            statusCode: res.statusCode,
                            headers: res.headers,
                            body: Buffer.concat(chunks, chunklen)
                        });
                    });
                }
            )
            .on('error', reject);
    });

const escapePropValue = value => {
    value = (value || '')
        .toString()
        .replace(/[\x00-\x1F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!/[\s\x00-\x1F\x7F-\uFFFF()<>,;:\\"/[\]?=]/.test(value)) {
        // return token value
        return value;
    }

    // return quoted string with escaped quotes
    return `"${value.replace(/["\\]/g, c => `\\${c}`)}"`;
};

const escapeCommentValue = value => {
    value = (value || '')
        .toString()
        .replace(/[\x00-\x1F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return `${value.replace(/[\\)]/g, c => `\\${c}`)}`;
};

const formatAuthHeaderRow = (method, status) => {
    status = status || {};
    let parts = [];

    parts.push(`${method}=${status.result || 'none'}`);

    if (status.comment) {
        parts.push(`(${escapeCommentValue(status.comment)})`);
    }

    for (let ptype of ['policy', 'smtp', 'body', 'header']) {
        if (!status[ptype] || typeof status[ptype] !== 'object') {
            continue;
        }

        for (let prop of Object.keys(status[ptype])) {
            if (status[ptype][prop]) {
                parts.push(`${ptype}.${prop}=${escapePropValue(status[ptype][prop])}`);
            }
        }
    }

    return parts.join(' ');
};

const formatRelaxedLine = (line, suffix) => {
    let result =
        line
            ?.toString('binary')
            // unfold
            .replace(/\r?\n/g, '')
            // key to lowercase, trim around :
            .replace(/^([^:]*):\s*/, (m, k) => k.toLowerCase().trim() + ':')
            // single WSP
            .replace(/\s+/g, ' ')
            .trim() + (suffix ? suffix : '');

    return Buffer.from(result, 'binary');
};

const formatDomain = domain => {
    domain = domain.toLowerCase().trim();
    try {
        domain = punycode.toASCII(domain).toLowerCase().trim();
    } catch (err) {
        // ignore punycode errors
    }
    return domain;
};

const getAligment = (fromDomain, domainList, strict) => {
    domainList = [].concat(domainList || []);
    if (strict) {
        fromDomain = formatDomain(fromDomain);
        for (let domain of domainList) {
            domain = formatDomain(psl.get(domain) || domain);
            if (formatDomain(domain) === fromDomain) {
                return domain;
            }
        }
    }

    // match org domains
    fromDomain = formatDomain(psl.get(fromDomain) || fromDomain);
    for (let domain of domainList) {
        domain = formatDomain(psl.get(domain) || domain);
        if (domain === fromDomain) {
            return domain;
        }
    }

    return false;
};

const validateAlgorithm = (algorithm, strict) => {
    try {
        if (!algorithm || !/^[^-]+-[^-]+$/.test(algorithm)) {
            throw new Error('Invalid algorithm format');
        }

        let [signAlgo, hashAlgo] = algorithm.toLowerCase().split('-');

        if (!['rsa', 'ed25519'].includes(signAlgo)) {
            throw new Error('Unknown signing algorithm: ' + signAlgo);
        }

        if (!['sha256'].concat(!strict ? 'sha1' : []).includes(hashAlgo)) {
            throw new Error('Unknown hashing algorithm: ' + hashAlgo);
        }
    } catch (err) {
        err.code = 'EINVALIDALGO';
        throw err;
    }
};

/**
 * Function takes Verified Mark Certificate file and parses domain names and SVG file
 * NB! Certificate is not verified in any way. If there are altNames and SVG content
 * available then these are returned even if the certificate is self signed or expired.
 * @param {Buffer} pem VMC file
 * @returns {Object|Boolean} Either an object with {altNames[], svg} or false if required data was missing from the certificate
 */
const parseLogoFromX509 = async pem => {
    const cert = Certificate.fromPEM(pem);

    const altNames = cert.extensions
        .filter(e => e.oid === '2.5.29.17')
        .flatMap(d => d?.altNames?.map(an => an?.dnsName?.trim()))
        .filter(an => an);
    if (!altNames.length) {
        return false;
    }

    let logo = cert.extensions.find(e => e.oid === '1.3.6.1.5.5.7.1.12');
    if (!logo?.value?.length) {
        return false;
    }

    let str = logo.value.toString();
    // No idea what is that binary stuff before the data uri block
    let dataMatch = /\bdata:/.test(str) && str.match(/\bbase64,/);
    if (dataMatch) {
        let b64 = str.substr(dataMatch.index + dataMatch[0].length);
        let svg = await gunzip(Buffer.from(b64, 'base64'));
        return {
            pem,
            altNames,
            svg: svg.toString()
        };
    }
    return false;
};

module.exports = {
    writeToStream,
    parseHeaders,

    defaultDKIMFieldNames,
    defaultARCFieldNames,
    defaultASFieldNames,

    getSigningHeaderLines,
    formatSignatureHeaderLine,
    parseDkimHeaders,
    getPublicKey,
    formatAuthHeaderRow,
    escapeCommentValue,
    fetch,

    validateAlgorithm,

    getAligment,

    formatRelaxedLine,

    parseLogoFromX509
};
