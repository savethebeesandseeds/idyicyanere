#include "sha256.h"

// Minimal, public-domain style SHA-256

#define ROTR(x,n) (((x)>>(n)) | ((x)<<(32-(n))))
#define SHR(x,n)  ((x)>>(n))
#define CH(x,y,z) (((x)&(y)) ^ (~(x)&(z)))
#define MAJ(x,y,z) (((x)&(y)) ^ ((x)&(z)) ^ ((y)&(z)))
#define BSIG0(x) (ROTR((x),2) ^ ROTR((x),13) ^ ROTR((x),22))
#define BSIG1(x) (ROTR((x),6) ^ ROTR((x),11) ^ ROTR((x),25))
#define SSIG0(x) (ROTR((x),7) ^ ROTR((x),18) ^ SHR((x),3))
#define SSIG1(x) (ROTR((x),17) ^ ROTR((x),19) ^ SHR((x),10))

static const uint32_t K[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

void sha256_bytes(const uint8_t *data, size_t len, uint8_t out[32]){
    uint32_t H[8] = { 0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                      0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19 };
    uint8_t block[64];
    size_t i;

    uint64_t bitlen = (uint64_t)len * 8;

    while(len >= 64){
        uint32_t W[64];
        for(i=0;i<16;i++){
            W[i] = (data[4*i]<<24) | (data[4*i+1]<<16) | (data[4*i+2]<<8) | (data[4*i+3]);
        }
        for(i=16;i<64;i++){
            W[i] = SSIG1(W[i-2]) + W[i-7] + SSIG0(W[i-15]) + W[i-16];
        }
        uint32_t a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for(i=0;i<64;i++){
            uint32_t T1 = h + BSIG1(e) + CH(e,f,g) + K[i] + W[i];
            uint32_t T2 = BSIG0(a) + MAJ(a,b,c);
            h=g; g=f; f=e; e=d + T1;
            d=c; c=b; b=a; a=T1 + T2;
        }
        H[0]+=a; H[1]+=b; H[2]+=c; H[3]+=d; H[4]+=e; H[5]+=f; H[6]+=g; H[7]+=h;
        data += 64; len -= 64;
    }

    // Pad remaining
    size_t rem = len;
    for(i=0;i<rem;i++) block[i] = data[i];
    block[rem++] = 0x80;
    if(rem > 56){
        while(rem < 64) block[rem++] = 0;
        // process block
        uint32_t W[64];
        for(i=0;i<16;i++){
            W[i] = (block[4*i]<<24) | (block[4*i+1]<<16) | (block[4*i+2]<<8) | (block[4*i+3]);
        }
        for(i=16;i<64;i++) W[i] = SSIG1(W[i-2]) + W[i-7] + SSIG0(W[i-15]) + W[i-16];
        uint32_t a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for(i=0;i<64;i++){
            uint32_t T1 = h + BSIG1(e) + CH(e,f,g) + K[i] + W[i];
            uint32_t T2 = BSIG0(a) + MAJ(a,b,c);
            h=g; g=f; f=e; e=d + T1;
            d=c; c=b; b=a; a=T1 + T2;
        }
        H[0]+=a; H[1]+=b; H[2]+=c; H[3]+=d; H[4]+=e; H[5]+=f; H[6]+=g; H[7]+=h;
        rem = 0;
    }
    while(rem < 56) block[rem++] = 0;
    // append length
    for(i=0;i<8;i++) block[56+7-i] = (uint8_t)((bitlen >> (8*i)) & 0xFF);

    // process final
    {
        uint32_t W[64];
        for(i=0;i<16;i++){
            W[i] = (block[4*i]<<24) | (block[4*i+1]<<16) | (block[4*i+2]<<8) | (block[4*i+3]);
        }
        for(i=16;i<64;i++) W[i] = SSIG1(W[i-2]) + W[i-7] + SSIG0(W[i-15]) + W[i-16];
        uint32_t a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for(i=0;i<64;i++){
            uint32_t T1 = h + BSIG1(e) + CH(e,f,g) + K[i] + W[i];
            uint32_t T2 = BSIG0(a) + MAJ(a,b,c);
            h=g; g=f; f=e; e=d + T1;
            d=c; c=b; b=a; a=T1 + T2;
        }
        H[0]+=a; H[1]+=b; H[2]+=c; H[3]+=d; H[4]+=e; H[5]+=f; H[6]+=g; H[7]+=h;
    }

    for(i=0;i<8;i++){
        out[4*i  ] = (uint8_t)((H[i] >> 24) & 0xFF);
        out[4*i+1] = (uint8_t)((H[i] >> 16) & 0xFF);
        out[4*i+2] = (uint8_t)((H[i] >> 8) & 0xFF);
        out[4*i+3] = (uint8_t)((H[i]      ) & 0xFF);
    }
}

void sha256_hex(const uint8_t *data, size_t len, char out_hex[65]){
    static const char *hex = "0123456789abcdef";
    uint8_t dig[32]; sha256_bytes(data, len, dig);
    for(int i=0;i<32;i++){ out_hex[2*i] = hex[(dig[i]>>4)&0xF]; out_hex[2*i+1] = hex[dig[i]&0xF]; }
    out_hex[64] = '\0';
}
