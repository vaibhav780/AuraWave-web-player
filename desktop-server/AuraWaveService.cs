using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;

public class AuraWaveService : ServiceBase
{
    private Process _process;
    private readonly string _logFile;

    public AuraWaveService()
    {
        this.ServiceName = "AuraWaveMusicServer";
        this.CanStop = true;
        this.CanShutdown = true;
        
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        _logFile = Path.Combine(baseDir, "service.log");
    }

    private void Log(string msg)
    {
        try
        {
            File.AppendAllText(_logFile, string.Format("[{0}] [Service] {1}\r\n", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), msg));
        }
        catch { }
    }

    protected override void OnStart(string[] args)
    {
        try
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string venvPy = Path.Combine(baseDir, ".venv\\Scripts\\python.exe");
            string pyExe = File.Exists(venvPy) ? venvPy : "python.exe";
            string script = Path.Combine(baseDir, "service_runner.py");

            Log("Starting AuraWave Music Server service...");
            Log("Using python: " + pyExe);
            Log("Target script: " + script);

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = pyExe,
                Arguments = "\"" + script + "\"",
                WorkingDirectory = baseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            _process = new Process();
            _process.StartInfo = psi;
            _process.OutputDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log("[Output] " + e.Data); };
            _process.ErrorDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log("[Error] " + e.Data); };

            _process.Start();
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();

            Log("Service process launched with PID: " + _process.Id);
        }
        catch (Exception ex)
        {
            Log("Failed to start service: " + ex.ToString());
            throw;
        }
    }

    protected override void OnStop()
    {
        Log("Stopping service...");
        StopProcess();
        Log("Service stopped.");
    }

    protected override void OnShutdown()
    {
        Log("System shutdown detected. Stopping service...");
        StopProcess();
    }

    private void StopProcess()
    {
        if (_process != null && !_process.HasExited)
        {
            try
            {
                Process killProc = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = "/PID " + _process.Id + " /T /F",
                    CreateNoWindow = true,
                    UseShellExecute = false
                });
                killProc.WaitForExit(4000);
            }
            catch (Exception ex)
            {
                Log("Error during taskkill: " + ex.Message);
            }

            try
            {
                if (!_process.HasExited)
                {
                    _process.Kill();
                    _process.WaitForExit(3000);
                }
            }
            catch { }
        }
    }

    public static void Main(string[] args)
    {
        ServiceBase.Run(new AuraWaveService());
    }
}
