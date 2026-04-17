import fs from 'fs';

const buf = fs.readFileSync('C:/Program Files (x86)/Steam/steamapps/common/Halo The Master Chief Collection/data/ui/Screens/loadingscreen.gfx');

console.log('Magic:', buf.slice(0,3).toString());
console.log('Version:', buf[3]);
console.log('FileLen:', buf.readUInt32LE(4), 'Actual:', buf.length);

// Skip RECT
let pos = 8;
const firstByte = buf[pos];
const nbits = (firstByte >> 3) & 0x1F;
const totalBits = 5 + 4 * nbits;
const totalBytes = Math.ceil(totalBits / 8);
console.log('RECT nbits:', nbits, 'RECT bytes:', totalBytes);
pos += totalBytes;
const frameRate = buf.readUInt16LE(pos);
const frameCount = buf.readUInt16LE(pos + 2);
console.log('FrameRate:', frameRate/256, 'FrameCount:', frameCount);
pos += 4;
console.log('Tags start at byte offset:', pos);

// Walk first 20 root tags
for (let i = 0; i < 20; i++) {
    if (pos >= buf.length - 1) break;
    const tagHdr = buf.readUInt16LE(pos);
    const code = (tagHdr >> 6) & 0x3FF;
    let len = tagHdr & 0x3F;
    const tagStart = pos;
    pos += 2;
    if (len === 0x3F) { len = buf.readUInt32LE(pos); pos += 4; }
    console.log('Tag ' + i + ': offset=' + tagStart + ' rawCode=' + code + ' len=' + len);
    pos += len;
}
