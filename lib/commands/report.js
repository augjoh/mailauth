'use strict';

const { authenticate } = require('../mailauth');
const fs = require('fs');

const cmd = async argv => {
    let source = argv.email;
    let useStdin = false;
    let stream;

    if (!source) {
        useStdin = true;
        source = 'standard input';
    }

    if (argv.verbose) {
        console.error(`Reading email message from ${source}`);
    }

    if (useStdin) {
        stream = process.stdin;
    } else {
        stream = fs.createReadStream(source);
    }

    const opts = {
        trustReceived: true
    };

    if (argv.clientIp) {
        opts.ip = argv.clientIp;
    }

    if (argv.maxLookups) {
        opts.maxResolveCount = argv.maxLookups;
    }

    for (let key of ['mta', 'helo', 'sender']) {
        if (argv[key]) {
            opts[key] = argv[key];
        }
    }

    if (argv.dnsCache) {
        let dnsCache = JSON.parse(await fs.promises.readFile(argv.dnsCache, 'utf-8'));

        opts.resolver = async (name, rr) => {
            let match = dnsCache?.[name]?.[rr];

            if (argv.verbose) {
                console.error(`DNS query for ${rr} ${name}: ${match ? JSON.stringify(match) : 'not found'}`);
            }

            if (!match) {
                let err = new Error('Error');
                err.code = 'ENOTFOUND';
                throw err;
            }

            return match;
        };
    }

    let result = await authenticate(stream, opts);
    process.stdout.write(JSON.stringify(result, false, 2) + '\n');
};

module.exports = cmd;
