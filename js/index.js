/*
 * This file contains the functions needed to run index.html
 */

// global variables
var CA = "https://acme-staging.api.letsencrypt.org",
    //CA = "https://acme-v01.api.letsencrypt.org",
    TERMS = "https://letsencrypt.org/documents/LE-SA-v1.0.1-July-27-2015.pdf",
    ACCOUNT_EMAIL, // "bar@foo.com"
    ACCOUNT_PUBKEY, // {
                    //   "pubkey": "-----BEGIN PUBLIC KEY...",
                    //   "jwk": {...},
                    //   "thumbprint": "deadbeef...",
                    //   "payload": "deadbeef...",
                    //   "protected": "deadbeef...",
                    //   "sig": "deadbeef...",
                    // }
    CSR, // {
         //   "csr": "deadbeef...", //DER encoded
         //   "payload": "deadbeef...",
         //   "protected": "deadbeef...",
         //   "sig": "deadbeef...",
         // }
    DOMAINS, // {
             //   "www.foo.com": {
             //
             //     "request_payload": "deadbeef...",
             //     "request_protected": "deadbeef...",
             //     "request_sig": "deadbeef...",
             //
             //     "challenge_payload": "deadbeef...",
             //     "challenge_protected": "deadbeef...",
             //     "challenge_sig": "deadbeef...",
             //
             //     "server_data": "deadbeef...",
             //     "server_uri": "deadbeef...",
             //     "confirmed": True,
             //
             //   },
             //   ...
             // }
    SIGNED_CERT; // "-----BEGIN CERTIFICATE..."

// show warning if no webcrypto digest
window.crypto = window.crypto || window.msCrypto; //for IE11
if(window.crypto && window.crypto.webkitSubtle){
    window.crypto.subtle = window.crypto.webkitSubtle; //for Safari
}
var DIGEST = window.crypto ? (window.crypto.subtle ? window.crypto.subtle.digest : undefined) : undefined;
document.getElementById("digest_error").style.display = DIGEST ? "none" : "block";

// SHA-256 shim for standard promise-based and IE11 event-based
function sha256(bytes, callback){
    var hash = window.crypto.subtle.digest({name: "SHA-256"}, bytes);
    // IE11
    if(!hash.then){
        hash.oncomplete = function(e){
            callback(new Uint8Array(e.target.result), undefined);
        };
        hash.onerror = function(e){
            callback(undefined, e);
        };
    }
    // standard promise-based
    else{
        hash.then(function(result){
            callback(new Uint8Array(result), undefined);
        })
        .catch(function(error){
            callback(undefined, error);
        });
    }
}

// url-safe base64 encoding
function b64(bytes){
    var str64 = typeof(bytes) === "string" ? window.btoa(bytes) : window.btoa(String.fromCharCode.apply(null, bytes));
    return str64.replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "");
}

// hide/show the help content
function helpContent(e){
    e.preventDefault();
    var help = document.getElementById(e.target.id + "_content");
    help.style.display = help.style.display === "none" ? "" : "none";
}
function bindHelps(elems){
    for(var i = 0; i < elems.length; i++){
        elems[i].addEventListener("click", helpContent);
    }
}
bindHelps(document.querySelectorAll(".help"));

// helper function to get a nonce via an ajax request to the ACME directory
function getNonce(callback){
    var xhr = new XMLHttpRequest();
    xhr.onload = function(){
        callback(xhr.getResponseHeader("Replay-Nonce"), undefined);
    };
    xhr.onerror = function(){
        callback(undefined, xhr);
    };
    xhr.open("GET", CA + "/directory");
    xhr.send();
}

// validate account info
function validateAccount(e){
    var status = document.getElementById("validate_account_status");
    function fail(msg){
        ACCOUNT_EMAIL = undefined;
        ACCOUNT_PUBKEY = undefined;
        status.style.display = "inline";
        status.className = "error";
        status.innerHTML = "";
        status.appendChild(document.createTextNode("Error: " + msg));
    }

    // clear previous status
    status.style.display = "inline";
    status.className = "";
    status.innerHTML = "validating...";

    // validate email
    var email_re = /^(([^<>()[\]\.,;:\s@\"]+(\.[^<>()[\]\.,;:\s@\"]+)*)|(\".+\"))@(([^<>()[\]\.,;:\s@\"]+\.)+[^<>()[\]\.,;:\s@\"]{2,})$/i;
    var email = document.getElementById("email").value;
    if(!email_re.test(email)){
        return fail("Account email doesn't look valid.");
    }

    // parse account public key
    var pubkey = document.getElementById("pubkey").value;
    if(pubkey === ""){
        return fail("You need to include an account public key.");
    }
    var unarmor = /-----BEGIN PUBLIC KEY-----([A-Za-z0-9+\/=\s]+)-----END PUBLIC KEY-----/;
    if(!unarmor.test(pubkey)){
        return fail("Your public key isn't formatted correctly.");
    }

    // find RSA modulus and exponent
    try{
        var pubkeyAsn1 = ASN1.decode(Base64.decode(unarmor.exec(pubkey)[1]));
        var modulusRaw = pubkeyAsn1.sub[1].sub[0].sub[0];
        var modulusStart = modulusRaw.header + modulusRaw.stream.pos + 1;
        var modulusEnd = modulusRaw.length + modulusRaw.stream.pos + modulusRaw.header;
        var modulusHex = modulusRaw.stream.hexDump(modulusStart, modulusEnd);
        var modulus = Hex.decode(modulusHex);
        var exponentRaw = pubkeyAsn1.sub[1].sub[0].sub[1];
        var exponentStart = exponentRaw.header + exponentRaw.stream.pos;
        var exponentEnd = exponentRaw.length + exponentRaw.stream.pos + exponentRaw.header;
        var exponentHex = exponentRaw.stream.hexDump(exponentStart, exponentEnd);
        var exponent = Hex.decode(exponentHex);
    }
    catch(err){
        return fail("Failed validating RSA public key.");
    }

    // generate the jwk header and bytes
    var jwk = {
        "e": b64(new Uint8Array(exponent)),
        "kty": "RSA",
        "n": b64(new Uint8Array(modulus)),
    }
    var jwk_json = JSON.stringify(jwk);
    var jwk_bytes = [];
    for(var i = 0; i < jwk_json.length; i++){
        jwk_bytes.push(jwk_json.charCodeAt(i));
    }

    // calculate thumbprint
    sha256(new Uint8Array(jwk_bytes), function(hash, err){

        // update the globals
        ACCOUNT_EMAIL = email;
        ACCOUNT_PUBKEY = {
            pubkey: pubkey,
            jwk: {
                alg: "RS256",
                jwk: jwk,
            },
            thumbprint: b64(hash),
        };

        // show the success text (simulate a delay so it looks like we thought hard)
        window.setTimeout(function(){
            status.style.display = "inline";
            status.className = "";
            status.innerHTML = "";
            status.appendChild(document.createTextNode("Looks good! Proceed to Step 2!"));
        }, 300);
    });
}
document.getElementById("validate_account").addEventListener("click", validateAccount);

// validate CSR
function validateCSR(e){
    var status = document.getElementById("validate_csr_status");
    function fail(msg){
        CSR = undefined;
        DOMAINS = undefined;
        status.style.display = "inline";
        status.className = "error";
        status.innerHTML = "";
        status.appendChild(document.createTextNode("Error: " + msg));
    }

    // clear previous status
    status.style.display = "inline";
    status.className = "";
    status.innerHTML = "validating...";

    // make sure there's an account public key and email
    if(!(ACCOUNT_EMAIL && ACCOUNT_PUBKEY)){
        return fail("Need to complete Step 1 first.");
    }

    // parse csr
    var csr = document.getElementById("csr").value;
    if(csr === ""){
        return fail("You need to include a CSR.");
    }
    var unarmor = /-----BEGIN CERTIFICATE REQUEST-----([A-Za-z0-9+\/=\s]+)-----END CERTIFICATE REQUEST-----/;
    if(!unarmor.test(csr)){
        return fail("Your CSR isn't formatted correctly.");
    }

    // find domains in the csr
    var domains = [];
    try{
        var csrAsn1 = ASN1.decode(Base64.decode(unarmor.exec(csr)[1]));

        // look for commonName in attributes
        if(csrAsn1.sub[0].sub[1].sub){
            var csrIds = csrAsn1.sub[0].sub[1].sub;
            for(var i = 0; i < csrIds.length; i++){
                var oidRaw = csrIds[i].sub[0].sub[0];
                var oidStart = oidRaw.header + oidRaw.stream.pos;
                var oidEnd = oidRaw.length + oidRaw.stream.pos + oidRaw.header;
                var oid = oidRaw.stream.parseOID(oidStart, oidEnd, Infinity);
                if(oid === "2.5.4.3"){
                    var cnRaw = csrIds[i].sub[0].sub[1];
                    var cnStart = cnRaw.header + cnRaw.stream.pos;
                    var cnEnd = cnRaw.length + cnRaw.stream.pos + cnRaw.header;
                    domains.push(cnRaw.stream.parseStringUTF(cnStart, cnEnd));
                }
            }
        }

        // look for subjectAltNames
        if(csrAsn1.sub[0].sub[3].sub){

            // find the PKCS#9 ExtensionRequest
            var xtns = csrAsn1.sub[0].sub[3].sub;
            for(var i = 0; i < xtns.length; i++){
                var oidRaw = xtns[i].sub[0];
                var oidStart = oidRaw.header + oidRaw.stream.pos;
                var oidEnd = oidRaw.length + oidRaw.stream.pos + oidRaw.header;
                var oid = oidRaw.stream.parseOID(oidStart, oidEnd, Infinity);
                if(oid === "1.2.840.113549.1.9.14"){

                    // find any subjectAltNames
                    for(var j = 0; j < xtns[i].sub[1].sub.length ? xtns[i].sub[1].sub : 0; j++){
                        for(var k = 0; k < xtns[i].sub[1].sub[j].sub.length ? xtns[i].sub[1].sub[j].sub : 0; k++){
                            var oidRaw = xtns[i].sub[1].sub[j].sub[k].sub[0];
                            var oidStart = oidRaw.header + oidRaw.stream.pos;
                            var oidEnd = oidRaw.length + oidRaw.stream.pos + oidRaw.header;
                            var oid = oidRaw.stream.parseOID(oidStart, oidEnd, Infinity);
                            if(oid === "2.5.29.17"){

                                // add each subjectAltName
                                var sans = xtns[i].sub[1].sub[j].sub[k].sub[1].sub[0].sub;
                                for(var s = 0; s < sans.length; s++){
                                    var sanRaw = sans[s];
                                    var sanStart = sanRaw.header + sanRaw.stream.pos;
                                    var sanEnd = sanRaw.length + sanRaw.stream.pos + sanRaw.header;
                                    domains.push(sanRaw.stream.parseStringUTF(sanStart, sanEnd));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    catch(err){
        return fail("Failed validating CSR.");
    }

    // update the globals
    CSR = {csr: b64(new Uint8Array(Base64.decode(unarmor.exec(csr)[1])))};
    DOMAINS = {};
    for(var d = 0; d < domains.length; d++){
        DOMAINS[domains[d]] = {};
    }

    //build account registration payload
    getNonce(function(nonce, err){
        ACCOUNT_PUBKEY['protected'] = b64(JSON.stringify({nonce: nonce}));
        ACCOUNT_PUBKEY['payload'] = b64(JSON.stringify({
            resource: "new-reg",
            contact: ["mailto:" + ACCOUNT_EMAIL],
            agreement: TERMS,
        }));
    });

    //build csr payload
    getNonce(function(nonce, err){
        CSR['protected'] = b64(JSON.stringify({nonce: nonce}));
        CSR['payload'] = b64(JSON.stringify({
            resource: "new-cert",
            csr: CSR['csr'],
        }));
    });

    //build domain payloads
    function buildDomain(domain){
        getNonce(function(nonce, err){
            DOMAINS[domain]['request_protected'] = b64(JSON.stringify({nonce: nonce}));
            DOMAINS[domain]['request_payload'] = b64(JSON.stringify({
                resource: "new-authz",
                identifier: {
                    type: "dns",
                    value: domain,
                },
            }));
        });
    }
    for(var i = 0; i < domains.length; i++){
        buildDomain(domains[i]);
    }

    //Wait for all the data payloads to finish building
    function waitForPayloads(){

        // check to see if account, csr, and domain new-authz are built
        var still_waiting = false;
        if(ACCOUNT_PUBKEY['payload'] === undefined || CSR['payload'] === undefined){
            still_waiting = true;
        }
        for(var d in DOMAINS){
            if(DOMAINS[d]['request_payload'] === undefined){
                still_waiting = true;
            }
        }

        // wait another period for nonces to load
        if(still_waiting){
            window.setTimeout(waitForPayloads, 1000);
        }

        // show the success text (simulate a delay so it looks like we thought hard)
        else{
            // build the account registration signature command
            var account_template = "" +
                "<input type='text' value='" +
                    "PRIV_KEY=./user.key; " +
                    "echo -n \"" + ACCOUNT_PUBKEY['protected'] + "." + ACCOUNT_PUBKEY['payload'] + "\" | " +
                    "openssl dgst -sha256 -sign $PRIV_KEY | " +
                    "base64 -w 685" +
                    "' readonly/><br/>" +
                "<input id='account_sig' type='text' " +
                    "placeholder='Paste the base64 output here (e.g. \"34QuzDI6cn...\")'></input>" +
                "<br/><br/>";

            // build the domain signature commands
            domain_templates = "";
            for(var d in DOMAINS){
                domain_templates += "" +
                    "<input type='text' value='" +
                        "PRIV_KEY=./user.key; " +
                        "echo -n \"" + DOMAINS[d]['request_protected'] + "." + DOMAINS[d]['request_payload'] + "\" | " +
                        "openssl dgst -sha256 -sign $PRIV_KEY | " +
                        "base64 -w 685" +
                        "' readonly/><br/>" +
                    "<input id='domain_sig_" + d.replace(/\./g, "_") + "' type='text' " +
                        "placeholder='Paste the base64 output here (e.g. \"34QuzDI6cn...\")'></input>" +
                    "<br/><br/>";
            }

            // build the csr registration signature command
            var csr_template = "" +
                "<input type='text' value='" +
                    "PRIV_KEY=./user.key; " +
                    "echo -n \"" + CSR['protected'] + "." + CSR['payload'] + "\" | " +
                    "openssl dgst -sha256 -sign $PRIV_KEY | " +
                    "base64 -w 685" +
                    "' readonly/><br/>" +
                "<input id='csr_sig' type='text' " +
                    "placeholder='Paste the base64 output here (e.g. \"34QuzDI6cn...\")'></input>";

            // insert the commands
            document.getElementById("step3_commands").innerHTML = "" +
                account_template + domain_templates + csr_template;

            // show the success text and step 3
            var domainString = "";
            for(var d in DOMAINS){
                domainString += d + ", ";
            }
            domainString = domainString.substr(0, domainString.length - 2);
            status.style.display = "inline";
            status.classNsame = "";
            status.innerHTML = "";
            status.appendChild(document.createTextNode(
                "Found domains! Proceed to Step 3! (" + domainString + ")"));
            document.getElementById("step3").style.display = null;
            document.getElementById("step3_pending").innerHTML = "";
        }
    }
    window.setTimeout(waitForPayloads, 1000);
}
document.getElementById("validate_csr").addEventListener("click", validateCSR);

// validate initial signatures
function validateInitialSigs(e){
    console.log("validateInitialSigs");
}
document.getElementById("validate_initial_sigs").addEventListener("click", validateInitialSigs);

// confirm domain check is running
function confirmDomainCheckIsRunning(e){
    console.log("confirmDomainCheckIsRunning");
}

// verify ownership
function verifyOwnership(e){
    console.log("verifyOwnership");
}

// request to sign certificate
function signCertificate(e){
    console.log("signCertificate");
}

