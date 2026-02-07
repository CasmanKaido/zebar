
const fs = require('fs');
const DLMM_Module = require("@meteora-ag/dlmm");
const DLMM = DLMM_Module.default || DLMM_Module;

console.log("Searching for Error 6052...");

try {
    const idl = DLMM_Module.IDL || DLMM.IDL;
    if (idl && idl.errors) {
        const err = idl.errors.find(e => e.code === 6052);
        if (err) {
            const result = `FOUND ERROR 6052:\nName: ${err.name}\nMessage: ${err.msg}`;
            fs.writeFileSync('error_6052.txt', result);
            console.log("Result written to error_6052.txt");
        } else {
            const result = `Error 6052 NOT FOUND. Max code is: ${idl.errors[idl.errors.length - 1].code}`;
            fs.writeFileSync('error_6052.txt', result);
            console.log("Result written to error_6052.txt");
        }
    } else {
        fs.writeFileSync('error_6052.txt', "IDL Not Found");
        console.log("IDL Not Found");
    }
} catch (e) {
    fs.writeFileSync('error_6052.txt', "Script Error: " + e.message);
    console.error("Script Error:", e);
}
