import { Image, View } from "@react-pdf/renderer";

interface QRCodeProps {
  data: string;
  size?: number;
}

export function QRCode({ data, size = 40 }: QRCodeProps) {
  return (
    <View style={{ marginTop: 20 }}>
      <Image src={data} alt="Invoice QR code" style={{ width: size, height: size }} />
    </View>
  );
}
