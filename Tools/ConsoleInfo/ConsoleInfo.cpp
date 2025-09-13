#include <Windows.h>
#include <Psapi.h>
#include <stdio.h>
#include <conio.h>

int main(int argc, char* argv[]) {
    if (argc != 2) {
        printf("�÷���ConsoleInfo.exe <command>\n");
        return -1;
    }

    CHAR Command[MAX_PATH];
    strcpy_s(Command, argv[1]);
    
    STARTUPINFO StartupInfo;
    PROCESS_INFORMATION ProcessInfo;
    PROCESS_MEMORY_COUNTERS_EX pmc;
    memset(&ProcessInfo, 0, sizeof(ProcessInfo));
    memset(&StartupInfo, 0, sizeof(StartupInfo));
    StartupInfo.cb = sizeof(StartupInfo);
    
    LARGE_INTEGER StartingTime, EndingTime, Frequency;
    QueryPerformanceFrequency(&Frequency);
    QueryPerformanceCounter(&StartingTime);

    if (!CreateProcess(NULL, Command, NULL, NULL, FALSE, 0, NULL, NULL, &StartupInfo, &ProcessInfo)) {
        printf("\n�޷��������̣�%s", Command);
        return -1;
    }

    // �ȴ����̽���
    WaitForSingleObject(ProcessInfo.hProcess, INFINITE);
    
    // ��ȡ�����ڴ���Ϣ
    GetProcessMemoryInfo(ProcessInfo.hProcess, (PROCESS_MEMORY_COUNTERS*)&pmc, sizeof(pmc));
    
    // ��ȡ����CPUʱ��
    FILETIME creationTime, exitTime, kernelTime, userTime;
    GetProcessTimes(ProcessInfo.hProcess, &creationTime, &exitTime, &kernelTime, &userTime);
    
    // ����������ʱ��
    QueryPerformanceCounter(&EndingTime);
    LONGLONG executionTime = (EndingTime.QuadPart - StartingTime.QuadPart) * 1000000 / Frequency.QuadPart;
    
    // ��ȡ�����˳�����
    DWORD returnValue;
    GetExitCodeProcess(ProcessInfo.hProcess, &returnValue);
    
    // ��FILETIMEת��Ϊ΢��
    ULARGE_INTEGER kernelTimeUL, userTimeUL;
    kernelTimeUL.LowPart = kernelTime.dwLowDateTime;
    kernelTimeUL.HighPart = kernelTime.dwHighDateTime;
    userTimeUL.LowPart = userTime.dwLowDateTime;
    userTimeUL.HighPart = userTime.dwHighDateTime;
    
    ULONGLONG totalKernelTime = kernelTimeUL.QuadPart / 10; // ת��Ϊ΢��
    ULONGLONG totalUserTime = userTimeUL.QuadPart / 10;     // ת��Ϊ΢��
    
    // �رս��̾��
    CloseHandle(ProcessInfo.hProcess);
    CloseHandle(ProcessInfo.hThread);
    
    // ������
    printf("\n-----------------------------------------------");
    printf("\n��ִ��ʱ�䣺%lld.%03lld ms", executionTime / 1000, executionTime % 1000);
    printf("\n�ڴ�ʹ�ã�%lu KB", (unsigned long)(pmc.PeakWorkingSetSize >> 10));
    printf("\nCPU�ں�ʱ�䣺%.3f ��", totalKernelTime / 1000000.0);
    printf("\nCPU�û�ʱ�䣺%.3f ��", totalUserTime / 1000000.0);
    printf("\n��CPUʱ�䣺%.3f ��", (totalKernelTime + totalUserTime) / 1000000.0);
    printf("\n���򷵻�ֵ��%ld (0x%lX)", returnValue, returnValue);
    printf("\n-----------------------------------------------");
    return 0;
}