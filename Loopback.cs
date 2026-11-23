using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace DshMeeting {
    // WASAPI interfaces are IUnknown based. Keep methods in native vtable order.
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class DeviceEnumerator { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator {
        void EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
        void GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice {
        void Activate(ref Guid id, uint clsctx, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    }
    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient {
        void Initialize(int mode, uint flags, long bufferDuration, long periodicity, IntPtr format, IntPtr session);
        void GetBufferSize(out uint frames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint frames);
        void IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
        void GetMixFormat(out IntPtr format);
        void GetDevicePeriod(out long standard, out long minimum);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr handle);
        void GetService(ref Guid id, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }
    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient {
        void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        void ReleaseBuffer(uint frames);
        void GetNextPacketSize(out uint frames);
    }

    internal sealed class MixFormat {
        internal readonly int Channels, Rate, Bits, Align;
        internal readonly bool Floating;
        internal readonly int[] Selected;
        internal MixFormat(IntPtr format) {
            int tag = (ushort)Marshal.ReadInt16(format, 0);
            Channels = (ushort)Marshal.ReadInt16(format, 2);
            Rate = Marshal.ReadInt32(format, 4);
            Align = (ushort)Marshal.ReadInt16(format, 12);
            Bits = (ushort)Marshal.ReadInt16(format, 14);
            uint mask = 0;
            if (tag == 0xfffe) {
                if ((ushort)Marshal.ReadInt16(format, 16) < 22) throw new InvalidDataException("Incomplete WAVEFORMATEXTENSIBLE");
                mask = (uint)Marshal.ReadInt32(format, 20);
                Guid subtype = (Guid)Marshal.PtrToStructure(IntPtr.Add(format, 24), typeof(Guid));
                if (subtype == new Guid("00000001-0000-0010-8000-00AA00389B71")) tag = 1;
                else if (subtype == new Guid("00000003-0000-0010-8000-00AA00389B71")) tag = 3;
            }
            Floating = tag == 3;
            if (Channels < 1 || Channels > 32 || Rate < 8000 || Rate > 384000 || Align != Channels * (Bits / 8) ||
                !(Floating ? Bits == 32 || Bits == 64 : tag == 1 && (Bits == 8 || Bits == 16 || Bits == 24 || Bits == 32))) {
                throw new NotSupportedException("Unsupported endpoint mix format: tag=" + tag + " channels=" + Channels + " rate=" + Rate + " bits=" + Bits);
            }
            // Drop the dedicated low-frequency effects channel when a speaker mask is available.
            var use = new System.Collections.Generic.List<int>();
            int channel = 0;
            for (int bit = 0; bit < 32 && channel < Channels; bit++) {
                if ((mask & (1u << bit)) == 0) continue;
                if (bit != 3) use.Add(channel);
                channel++;
            }
            if (channel != Channels || use.Count == 0) { use.Clear(); for (int i = 0; i < Channels; i++) use.Add(i); }
            Selected = use.ToArray();
        }
        internal double Mono(byte[] data, int frame) {
            double sum = 0;
            foreach (int channel in Selected) {
                int i = frame * Align + channel * (Bits / 8);
                double x;
                if (Floating) x = Bits == 32 ? (double)BitConverter.ToSingle(data, i) : BitConverter.ToDouble(data, i);
                else if (Bits == 8) x = (data[i] - 128) / 128.0;
                else if (Bits == 16) x = BitConverter.ToInt16(data, i) / 32768.0;
                else if (Bits == 24) x = ((data[i] << 8) | (data[i + 1] << 16) | (data[i + 2] << 24)) / 2147483648.0;
                else x = BitConverter.ToInt32(data, i) / 2147483648.0;
                if (!double.IsNaN(x) && !double.IsInfinity(x)) sum += Math.Max(-1, Math.Min(1, x));
            }
            return sum / Selected.Length;
        }
    }
    internal sealed class LowPass {
        readonly double b0, b1, b2, a1, a2;
        double z1, z2;
        internal LowPass(int rate, double q) {
            double w = 2 * Math.PI * 6800 / rate, cosine = Math.Cos(w), alpha = Math.Sin(w) / (2 * q);
            b0 = (1 - cosine) / (2 * (1 + alpha)); b1 = 2 * b0; b2 = b0;
            a1 = -2 * cosine / (1 + alpha); a2 = (1 - alpha) / (1 + alpha);
        }
        internal double Sample(double input) {
            double y = b0 * input + z1;
            z1 = b1 * input - a1 * y + z2; z2 = b2 * input - a2 * y;
            return y;
        }
    }
    // Fixed-rate phase accumulator, 4-pole antialias filter and signed little-endian output.
    internal sealed class Converter {
        readonly Stream output;
        readonly int rate;
        readonly LowPass stage1, stage2;
        readonly byte[] packet = new byte[640]; // 20 ms
        int used, phase;
        double integral;
        internal Converter(int rate, Stream output) {
            this.rate = rate; this.output = output;
            if (rate > 16000) { stage1 = new LowPass(rate, 0.5411961); stage2 = new LowPass(rate, 1.306563); }
        }
        internal void Push(double value) {
            if (stage1 != null) value = stage2.Sample(stage1.Sample(value));
            int credit = 16000;
            while (credit > 0) {
                int weight = Math.Min(credit, rate - phase);
                integral += value * weight; phase += weight; credit -= weight;
                if (phase == rate) { Emit(integral / rate); phase = 0; integral = 0; }
            }
        }
        void Emit(double value) {
            short pcm = (short)Math.Round(Math.Max(-1, Math.Min(1, value)) * (value < 0 ? 32768 : 32767));
            packet[used++] = (byte)pcm; packet[used++] = (byte)(pcm >> 8);
            if (used == packet.Length) FlushPacket();
        }
        void FlushPacket() { if (used != 0) { output.Write(packet, 0, used); output.Flush(); used = 0; } }
        internal void Finish() { if (phase * 2 >= rate) Emit(integral / phase); FlushPacket(); }
    }
    internal sealed class Endpoint : IDisposable {
        IMMDeviceEnumerator enumerator;
        IMMDevice device;
        IAudioClient client;
        IAudioCaptureClient capture;
        IntPtr formatPtr;
        internal MixFormat Format;
        bool started;
        internal Endpoint() {
            try {
                enumerator = (IMMDeviceEnumerator)new DeviceEnumerator();
                enumerator.GetDefaultAudioEndpoint(0, 1, out device); // eRender, eMultimedia
                Guid id = typeof(IAudioClient).GUID; object instance;
                device.Activate(ref id, 23, IntPtr.Zero, out instance);
                client = (IAudioClient)instance;
                client.GetMixFormat(out formatPtr);
                Format = new MixFormat(formatPtr);
            } catch { Dispose(); throw; }
        }
        internal void Run(Stream output, Func<bool> stopping) {
            client.Initialize(0, 0x00020000, 1000000, 0, formatPtr, IntPtr.Zero); // shared, LOOPBACK, 100 ms
            Guid iid = typeof(IAudioCaptureClient).GUID; object service;
            client.GetService(ref iid, out service); capture = (IAudioCaptureClient)service;
            var converter = new Converter(Format.Rate, output);
            var clock = Stopwatch.StartNew();
            double qpcBase = Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;
            client.Start(); started = true;
            output.Write(new byte[] {87, 76, 80, 49}, 0, 4); output.Flush(); // WLP1, followed strictly by PCM
            byte[] buffer = new byte[0]; long cursor = 0;
            while (!stopping()) {
                uint available;
                capture.GetNextPacketSize(out available);
                while (available > 0 && !stopping()) {
                    IntPtr data; uint frames, flags; ulong devicePos, qpc;
                    capture.GetBuffer(out data, out frames, out flags, out devicePos, out qpc);
                    try {
                        int count = checked((int)frames);
                        if (count > Format.Rate) throw new IOException("Unexpected WASAPI packet size");
                        bool silence = (flags & 2) != 0 || data == IntPtr.Zero;
                        if (!silence) {
                            int bytes = checked(count * Format.Align);
                            if (buffer.Length < bytes) buffer = new byte[bytes];
                            Marshal.Copy(data, buffer, 0, bytes);
                        }
                        long stamp = (flags & 4) == 0 && qpc != 0 ? (long)Math.Round((qpc / 1e7 - qpcBase) * Format.Rate) : cursor;
                        // Normal packet timestamps jitter slightly. Preserve the sample count for adjacent packets.
                        if (Math.Abs(stamp - cursor) <= Format.Rate / 100) stamp = cursor;
                        if (stamp - cursor > Format.Rate * 2L) throw new IOException("System audio clock discontinuity");
                        while (cursor < stamp) { converter.Push(0); cursor++; }
                        int skip = (int)Math.Min(count, Math.Max(0, cursor - stamp));
                        for (int i = skip; i < count; i++) { converter.Push(silence ? 0 : Format.Mono(buffer, i)); cursor++; }
                    } finally { capture.ReleaseBuffer(frames); }
                    capture.GetNextPacketSize(out available);
                }
                // Some render endpoints send no packets while every application is silent.
                // Keep the microphone and system timelines aligned, allowing 120 ms for late packets.
                long quietUntil = (long)((clock.Elapsed.TotalSeconds - 0.12) * Format.Rate);
                if (quietUntil - cursor > Format.Rate * 2L) throw new IOException("System audio consumer stalled");
                while (cursor < quietUntil) { converter.Push(0); cursor++; }
                Thread.Sleep(8);
            }
            converter.Finish();
        }
        public void Dispose() {
            if (started) { try { client.Stop(); } catch (COMException) { } started = false; }
            if (capture != null) Marshal.ReleaseComObject(capture);
            if (formatPtr != IntPtr.Zero) { Marshal.FreeCoTaskMem(formatPtr); formatPtr = IntPtr.Zero; }
            if (client != null) Marshal.ReleaseComObject(client);
            if (device != null) Marshal.ReleaseComObject(device);
            if (enumerator != null) Marshal.ReleaseComObject(enumerator);
        }
    }
    public static class Loopback {
        public static void Run() {
            // PowerShell's apartment may be STA. Own all audio COM objects on one MTA thread.
            int done = 0; Exception failure = null;
            var watch = new Thread(delegate() {
                try { Console.OpenStandardInput().ReadByte(); } catch (IOException) { }
                Interlocked.Exchange(ref done, 1);
            });
            watch.IsBackground = true; watch.Start();
            var worker = new Thread(delegate() {
                try {
                    using (var endpoint = new Endpoint())
                    using (var output = Console.OpenStandardOutput()) endpoint.Run(output, delegate { return Interlocked.CompareExchange(ref done, 0, 0) != 0; });
                } catch (Exception e) { failure = e; }
            });
            worker.SetApartmentState(ApartmentState.MTA); worker.Start(); worker.Join();
            if (failure != null) throw new IOException("WASAPI loopback failed: " + failure.Message, failure);
        }
    }
}
