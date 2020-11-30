![](https://github.com/andris9/mailauth/raw/master/assets/mailauth.png)

Email authentication library for Node.js

-   [x] SPF verification
-   [x] DKIM signing
-   [x] DKIM verification
-   [x] DMARC verification
-   [x] ARC verification
-   [x] ARC sealing
    -   [x] Sealing on authentication
    -   [x] Sealing after modifications
-   [x] BIMI resolving
-   [x] MTA-STS helpers

Pure JavaScript implementation, no external applications or compilation needed. Runs on any server/device that has Node 14+ installed.

## Usage

## Authentication

Validate DKIM signatures, SPF, DMARC, ARC and BIMI for an email.

```js
const { authenticate } = require('mailauth');
const { dkim, spf, arc, dmarc, bimi, receivedChain, headers } = await authenticate(
    message, // either a String, a Buffer or a Readable Stream
    {
        // SMTP transmission options if available
        ip: '217.146.67.33', // SMTP client IP
        helo: 'uvn-67-33.tll01.zonevs.eu', // EHLO/HELO hostname
        sender: 'andris@ekiri.ee', // MAIL FROM address

        // If you do not want to provide ip/helo/sender manually but parse from the message
        //trustReceived: true,

        // Server processing this message, defaults to os.hostname(). Inserted into Authentication headers
        mta: 'mx.ethereal.email',

        //  Optional  DNS resolver function (defaults to `dns.promises.resolve`)
        resolver: async (name, rr) => await dns.promises.resolve(name, rr)
    }
);
// output authenticated message
process.stdout.write(headers); // includes terminating line break
process.stdout.write(message);
```

Example output:

```
Received-SPF: pass (mx.ethereal.email: domain of andris@ekiri.ee designates 217.146.67.33 as permitted sender) client-ip=217.146.67.33;
Authentication-Results: mx.ethereal.email;
 dkim=pass header.i=@ekiri.ee header.s=default header.a=rsa-sha256 header.b=TXuCNlsq;
 spf=pass (mx.ethereal.email: domain of andris@ekiri.ee designates 217.146.67.33 as permitted sender) smtp.mailfrom=andris@ekiri.ee
 smtp.helo=uvn-67-33.tll01.zonevs.eu;
 arc=pass (i=2 spf=neutral dkim=pass dkdomain=ekiri.ee);
 dmarc=none header.from=ekiri.ee
From: ...
```

You can see full output (structured data for DKIM, SPF, DMARC and ARC) from [this example](https://gist.github.com/andris9/6514b5e7c59154a5b08636f99052ce37).

### receivedChain

`receivedChain` property is an array of parsed representations of the `Received:` headers

## DKIM

### Signing

```js
const { dkimSign } = require('mailauth/lib/dkim/sign');
const signResult = await dkimSign(
    message, // either a String, a Buffer or a Readable Stream
    {
        // Optional, default canonicalization, default is "relaxed/relaxed"
        canonicalization: 'relaxed/relaxed', // c=

        // Optional, default signing and hashing algorithm
        // Mostly useful when you want to use rsa-sha1, otherwise no need to set
        algorithm: 'rsa-sha256',

        // Optional, default is current time
        signTime: new Date(), // t=

        // Keys for one or more signatures
        // Different signatures can use different algorithms (mostly useful when
        // you want to sign a message both with RSA and Ed25519)
        signatureData: [
            {
                signingDomain: 'tahvel.info', // d=
                selector: 'test.rsa', // s=
                // supported key types: RSA, Ed25519
                privateKey: fs.readFileSync('./test/fixtures/private-rsa.pem'),

                // Optional algorithm, default is derived from the key.
                // Overrides whatever was set in parent object
                algorithm: 'rsa-sha256',

                // Optional signature specifc canonicalization, overrides whatever was set in parent object
                canonicalization: 'relaxed/relaxed' // c=
            }
        ]
    }
); // -> {signatures: String, errors: Array} signature headers using \r\n as the line separator
// show signing errors (if any)
if (signResult.errors.length) {
    console.log(signResult.errors);
}
// output signed message
process.stdout.write(signResult.signatures); // includes terminating line break
process.stdout.write(message);
```

Example output:

```
DKIM-Signature: a=rsa-sha256; v=1; c=relaxed/relaxed; d=tahvel.info;
 s=test.rsa; b=...
From: ...
```

### Verifying

```js
const { dkimVerify } = require('mailauth/lib/dkim/verify');
// `message` is either a String, a Buffer or a Readable Stream
const result = await dkimVerify(message);
for (let { info } of result.results) {
    console.log(info);
}
```

Example output:

```txt
dkim=neutral (invalid public key) header.i=@tahvel.info header.s=test.invalid header.b="b85yao+1"
dkim=pass header.i=@tahvel.info header.s=test.rsa header.b="BrEgDN4A"
dkim=policy policy.dkim-rules=weak-key header.i=@tahvel.info header.s=test.small header.b="d0jjgPun"
```

## SPF

### Verifying

```js
const { spf } = require('mailauth/lib/spf');

let result = await spf({
    sender: 'andris@wildduck.email',
    ip: '217.146.76.20',
    helo: 'foo',
    mta: 'mx.myhost.com'
});
console.log(result.header);
```

Example output:

```txt
Received-SPF: pass (mx.myhost.com: domain of andris@wildduck.email
 designates 217.146.76.20 as permitted sender) client-ip=217.146.76.20;
 envelope-from="andris@wildduck.email";
```

## ARC

### Validation

ARC seals are automatically validated during the authentication step.

```js
const { authenticate } = require('mailauth');
const { arc } = await authenticate(
    message, // either a String, a Buffer or a Readable Stream
    {
        // SMTP transmission options must be provided as
        // these are not parsed from the message
        ip: '217.146.67.33', // SMTP client IP
        helo: 'uvn-67-33.tll01.zonevs.eu', // EHLO/HELO hostname
        mta: 'mx.ethereal.email', // server processing this message, defaults to os.hostname()
        sender: 'andris@ekiri.ee' // MAIL FROM address
    }
);
console.log(arc);
```

Output being something like this:

```
{
  "status": {
    "result": "pass",
    "comment": "i=2 spf=neutral dkim=pass dkdomain=zonevs.eu dkim=pass dkdomain=srs3.zonevs.eu dmarc=fail fromdomain=zone.ee"
  },
  "i": 2,
  ...
}
```

### Sealing

#### During authentication

You can seal messages with ARC automatically in the authentication step by providing the sealing key. In this case you can not modify the message anymore as this would break the seal.

```js
const { authenticate } = require('mailauth');
const { headers } = await authenticate(
    message, // either a String, a Buffer or a Readable Stream
    {
        // SMTP transmission options must be provided as
        // these are not parsed from the message
        ip: '217.146.67.33', // SMTP client IP
        helo: 'uvn-67-33.tll01.zonevs.eu', // EHLO/HELO hostname
        mta: 'mx.ethereal.email', // server processing this message, defaults to os.hostname()
        sender: 'andris@ekiri.ee', // MAIL FROM address

        // Optional ARC seal settings. If this is set then resulting headers include
        // a complete ARC header set (unless the message has a failing ARC chain)
        seal: {
            signingDomain: 'tahvel.info',
            selector: 'test.rsa',
            privateKey: fs.readFileSync('./test/fixtures/private-rsa.pem')
        }
    }
);
// output authenticated and sealed message
process.stdout.write(headers); // includes terminating line break
process.stdout.write(message);
```

#### After modifications

If you want to modify the message before sealing then you have to authenticate the message first and then use authentication results as input for the sealing step.

```js
const { authenticate, sealMessage } = require('@postalsys/mailauth');

// 1. authenticate the message
const { arc, headers } = await authenticate(
    message, // either a String, a Buffer or a Readable Stream
    {
        ip: '217.146.67.33', // SMTP client IP
        helo: 'uvn-67-33.tll01.zonevs.eu', // EHLO/HELO hostname
        mta: 'mx.ethereal.email', // server processing this message, defaults to os.hostname()
        sender: 'andris@ekiri.ee' // MAIL FROM address
    }
);

// 2. perform some modifications with the message ...

// 3. seal the modified message using the initial authentication results
const sealHeaders = await sealMessage(message, {
    signingDomain: 'tahvel.info',
    selector: 'test.rsa',
    privateKey: fs.readFileSync('./test/fixtures/private-rsa.pem'),

    // values from the authentication step
    authResults: arc.authResults,
    cv: arc.status.result
});

// output authenticated message
process.stdout.write(sealHeaders); // ARC set
process.stdout.write(headers); // authentication results
process.stdout.write(message);
```

## BIMI

Brand Indicators for Message Identification (BIMI) support is based on [draft-blank-ietf-bimi-01](https://tools.ietf.org/html/draft-blank-ietf-bimi-01).

BIMI information is resolved in the authentication step and the results can be found from the `bimi` property. Message must pass DMARC validation in order to be processed for BIMI. DMARC policy can not be "none" for BIMI to pass.

```js
const { bimi } = await authenticate(
    message, // either a String, a Buffer or a Readable Stream
    {
        ip: '217.146.67.33', // SMTP client IP
        helo: 'uvn-67-33.tll01.zonevs.eu', // EHLO/HELO hostname
        mta: 'mx.ethereal.email', // server processing this message, defaults to os.hostname()
        sender: 'andris@ekiri.ee' // MAIL FROM address
    }
);
if (bimi?.location) {
    console.log(`BIMI location: ${bimi.location}`);
}
```

`BIMI-Location` header is ignored by `mailauth`, it is not checked for and it is not modified in any way if it is present. `BIMI-Selector` is used for selector selection (if available).

### Verified Mark Certificate

Authority Evidence Document location is available from the `bimi.authority` property (if set).

VMC (Verified Mark Certificates) for Authority Evidence Documents is a X509 certificate with an `id-pe-logotype` extension (`oid=1.3.6.1.5.5.7.1.12`) that includes a compressed SVG formatted logo file ([read more here](https://bimigroup.org/resources/VMC_Guidelines_latest.pdf)).

Some example authority evidence documents:

-   [from default.\_bimi.cnn.com](https://amplify.valimail.com/bimi/time-warner/LysAFUdG-Hw-cnn_vmc.pem)
-   [from default.\_bimi.entrustdatacard.com](https://www.entrustdatacard.com/-/media/certificate/Entrust%20VMC%20July%2014%202020.pem)

You can parse logos from these certificate files by using the `parseLogoFromX509` function

```js
const { parseLogoFromX509 } = require('mailauth/lib/tools');
let { altnNames, svg } = await parseLogoFromX509(fs.readFileSync('vmc.pem'));
```

> **NB!** `parseLogoFromX509` does not verify the validity of the VMC certificate. It could be self signed or expired and still be processed.

## MTA-STS

`mailauth` allows you to fetch MTA-STS information for a domain name.

```js
const { getPolicy, validateMx } = require('mailauth/lib/mta-sts');

let knownPolicy = getCachedPolicy('gmail.com'); // optional
let mx = 'alt4.gmail-smtp-in.l.google.com';

const { policy, status } = await getPolicy('gmail.com', knownPolicy);
const policyMatch = validateMx(mx, policy);

if (policy.id !== knownPolicy?.id) {
    // policy has been updated, update cache
}

if (policy.mode === 'enforce') {
    // must use TLS
}

if (policy.mx && !policyMatch) {
    // can't connect, unlisted MX
}
```

### Resolve policy

Resolve MTA-STS policy for a domain

```
async getPolicy(domain [,knownPolicy]) -> {policy, status}
```

Where

-   **domain** is the domain to check for (eg. "gmail.com")
-   **knownPolicy** (optional) is the policy object from last check for this domain. This is used to check if the policy is still valid or it was updated.

Function returns an object with the following properties:

-   **policy** (object)
    -   **id** (string or `false`) ID of the policy
    -   **mode** (string) one of _"none"_, _"testing"_ or _"enforce"_
    -   **mx** (array, if available) an Array of whitelisted MX hostnames
    -   **expires** (string, if available) ISO date string for cacheing
-   **status** (string) one of the following values:
    -   _"not_found"_ no policy was found for this domain. You can decide yourself how long you want to cache this response
    -   _"cached"_ no changes detected, current policy is still valid and can be used
    -   _"found"_ new or updated policy was found. Cache this in your system until _policy.expires_
    -   _"renew"_ existing policy is still valid, renew cached version until _policy.expires_
    -   _"errored"_ policy discovery failed for some temporary error (eg. failing DNS queries). See _policy.error_ for details

### Validate MX hostname

Check if a resolved MX hostname is valid by MTA-STS policy or not

```
validateMx(mx, policy) -> Boolean
```

Where

-   **mx** is the resolved MX hostname (eg. "gmail-smtp-in.l.google.com")
-   **policy** is the policy object returned by `getPolicy()`

Function returns a boolean. If it is `true` then MX hostname is allowed to use.

## Command line usage

Install `mailauth` globally to get the command line interface

```
npm install -g mailauth
```

### Available commands

#### report

`report` command takes an email message and returns a JSON formatted report for SPF, DKIM, ARC, DMARC and BIMI. Not all reports might make sense for your use case, eg. SPF check for an outbound message usually gives no useful info, so you can ignore the parts you're not interested in.

```
$ mailauth report [options] [email]
```

Where

-   **options** are option flags
-   **email** is the path to EML formatted email message file. If not provided then email message is read from standard input

**Options**

-   `--client-ip x.x.x.x` or `-c x.x.x.x` is the IP of the remote client that sent the email. If not provided then it is parsed from the latest `Received` header
-   `--sender user@example.com` or `-s address` is the email address from the MAIL FROM command. If not provided then it is parsed from the latest Return-Path header
-   `--helo hostname` or `-e hostname` is the client hostname from the HELO/EHLO command. Used in some obscure SPF validation operations
-   `--mta hostname` or `-m hostname` is the server hostname doing the validation checks. Defaults to `os.hostname()`
-   `--dns-cache /path/to/dns.json` or `-d path` is the path to a file with cached DNS query responses. If this file is provided then no actual DNS requests are performed, only cached values from this file are used.
-   `--verbose` or `-v` if this flag is set then mailauth writes some debugging info to standard error

**Example**

```
$ mailauth report -v --dns-cache examples/dns-cache.json test/fixtures/message2.eml
Reading email message from test/fixtures/message2.eml
DNS query for TXT mail.projectpending.com: not found
DNS query for TXT _dmarc.projectpending.com: not found
{
  "receivedChain": [
  ...
```

See full example for DKIM checks [here](https://gist.github.com/andris9/8d4ab527282041f6725a640d80da4872).

#### DNS cache file

In general you would use the `--dns-cache` option only when testing. This way you can provide different kind of DNS responses without actually setting up a DNS server and unlike when using real DNS you do not have to wait for the changes in the DNS server to propagate – whatever is in the provided cache file, is used for the DNS query responses.

DNS cache file includes a JSON encoded object where main keys are the domain names (eg. `"_dmarc.example.com"`), sub keys are resource record types (eg. `"TXT"`) and values are the corresponding values as provided by the [dns module](https://nodejs.org/api/dns.html#dns_dns_resolvetxt_hostname_callback).

```json
{
    "full_domain_name": {
        "TXT": [["string1"]]
    }
}
```

**Example**

This example provides SPF and DMARC policy records for "example.com":

```json
{
    "example.com": {
        "TXT": [["v=spf1 include:_spf.google.com include:sendgrid.net", " include:servers.mcsv.net include:servers.outfunnel.com ip4:18.194.223.2 ~all"]]
    },
    "_dmarc.example.com": {
        "TXT": [["v=DMARC1; p=reject; sp=reject;"]]
    }
}
```

## Testing

`mailauth` uses the following test suites:

### SPF test suite

[OpenSPF test suite](http://www.openspf.org/Test_Suite) ([archive.org mirror](https://web.archive.org/web/20190130131432/http://www.openspf.org/Test_Suite)) with the following differences:

-   No PTR support in `mailauth`, all PTR related tests are ignored
-   Less strict whitespace checks (`mailauth` accepts multiple spaces between tags etc)
-   Some macro tests are skipped (macro expansion is supported _in most parts_)
-   Some tests where invalid component is listed after a matching part (mailauth processes from left to right and returns on first match found)
-   Other than that all tests pass

### ARC test suite from ValiMail

ValiMail [arc_test_suite](https://github.com/ValiMail/arc_test_suite)

-   `mailauth` is less strict on header tags and casing, for example uppercase `S=` for a selector passes in `mailauth` but fails in ValiMail.
-   Signing test suite is used for input only. All listed messages are signed using provided keys but signatures are not matched against reference. Instead `mailauth` validates the signatures itself and looks for the same cv= output that the ARC-Seal header in the test suite has
-   Other than that all tests pass

## Setup

### Free, AGPL-licensed version

First install the module from npm:

```
$ npm install mailauth
```

next import any method you want to use from mailauth package into your script:

```js
const { authenticate } = require('mailauth');
```

### MIT version

MIT-licensed version is available for [Postal Systems subscribers](https://postalsys.com/).

First install the module from Postal Systems private registry:

```
$ npm install @postalsys/mailauth
```

next import any method you want to use from mailauth package into your script:

```js
const { authenticate } = require('@postalsys/mailauth');
```

If you have already built your application using the free version of "mailauth" and do not want to modify require statements in your code, you can install the MIT-licensed version as an alias for "mailauth".

```
$ npm install mailauth@npm:@postalsys/mailauth
```

This way you can keep using the old module name

```js
const { authenticate } = require('mailauth');
```

## License

&copy; 2020 Andris Reinman

Dual licensed under GNU Affero General Public License v3.0 or later or EUPLv1.1+

MIT-licensed version of mailauth is available for [Postal Systems subscribers](https://postalsys.com/).
