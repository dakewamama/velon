// Solana Mobile draws a QR code only in its remote mode, which Velon never registers.
const unused = () => {
  throw new Error("Velon does not use Solana Mobile's QR mode.");
};
module.exports = { toString: unused, toCanvas: unused, toDataURL: unused, create: unused };
