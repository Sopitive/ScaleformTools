// Investigate GFX tag 1009 structure more carefully
const buf = require('fs').readFileSync('C:/Program Files (x86)/Steam/steamapps/common/Halo The Master Chief Collection/data/ui/Screens/loadingscreen.gfx');
const zlib = require('zlib');
const body = zlib.inflateSync(buf.slice(8));
const nbits = (body[0] >> 3) & 0x1F;
const totalBytes = Math.ceil((5 + 4*nbits)/8);
let pos = totalBytes + 4;

// Bit reader utility
function readBitStream(buf, startByte) {
    let bytePos = startByte;
    let bitPos = 7; // MSB first
    return {
        readUB(n) {
            let result = 0;
            for (let i = 0; i < n; i++) {
                result = (result << 1) | ((buf[bytePos] >> bitPos) & 1);
                bitPos--;
                if (bitPos < 0) { bitPos = 7; bytePos++; }
            }
            return result;
        },
        readSB(n) {
            const u = this.readUB(n);
            if (n === 0) return 0;
            return (u & (1 << (n-1))) ? u - (1 << n) : u;
        },
        align() {
            if (bitPos !== 7) { bitPos = 7; bytePos++; }
        },
        get pos() { return bytePos; }
    };
}

function parseMatrix(body, offset) {
    const reader = readBitStream(body, offset);
    const hasScale = reader.readUB(1) === 1;
    let scaleX = 1, scaleY = 1;
    if (hasScale) {
        const scaleNBits = reader.readUB(5);
        scaleX = reader.readSB(scaleNBits) / 65536;
        scaleY = reader.readSB(scaleNBits) / 65536;
    }
    const hasRotate = reader.readUB(1) === 1;
    if (hasRotate) {
        const rNBits = reader.readUB(5);
        reader.readSB(rNBits); reader.readSB(rNBits);
    }
    const tNBits = reader.readUB(5);
    const tx = reader.readSB(tNBits) / 20;
    const ty = reader.readSB(tNBits) / 20;
    reader.align();
    return { scaleX, scaleY, tx, ty, endByte: reader.pos };
}

// Walk and find top-level GFX PlaceObject (1009) tags with matrix
let count = 0;
while(pos < body.length-1) {
    const hdr = body.readUInt16LE(pos);
    const code = (hdr>>6)&0x3FF;
    let len = hdr&0x3F; const tagStart=pos; pos+=2;
    let isLong = false;
    if(len===0x3F){len=body.readUInt32LE(pos);pos+=4;isLong=true;}
    const bodyStart = pos;
    
    if (code === 1009) {
        // GFX PlaceObject (custom tag) - determine structure
        // Try PlaceObject2 layout (flags at byte 0)
        const flags = body[bodyStart];
        const hasChar = !!(flags & 0x02);
        const hasMatrix = !!(flags & 0x04);
        const depth = body.readUInt16LE(bodyStart+1);
        let off = bodyStart + 3;
        let charId;
        if (hasChar) { charId = body.readUInt16LE(off); off+=2; }
        if (hasMatrix) {
            const mat = parseMatrix(body, off);
            console.log('GFXPlace['+count+']: depth='+depth+' charId='+charId+' tx='+mat.tx+' ty='+mat.ty+' sx='+mat.scaleX.toFixed(3)+' sy='+mat.scaleY.toFixed(3)+' matrixAt='+off);
        } else {
            console.log('GFXPlace['+count+']: depth='+depth+' charId='+charId+' noMatrix');
        }
        count++;
    }
    
    pos += len;
    if(code===0) break;
}

// Also show the one PlaceObject2 (root sprite)
console.log('\nAlso check: PlaceObject2 (code=26) at 10928, depth=1, charId=72');
const mat = parseMatrix(body, 10939);
console.log('Root matrix: tx='+mat.tx+' ty='+mat.ty+' sx='+mat.scaleX.toFixed(3)+' sy='+mat.scaleY.toFixed(3));
