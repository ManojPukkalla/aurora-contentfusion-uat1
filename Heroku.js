var express = require('express');
var queue = require('express-queue');
var bodyParser = require('body-parser');
//var pdfmerger = require('pdfmerger'); //Need Java buildpack & pb settings JVM
var merge = require('easy-pdf-merge'); //Test OK
var fs = require('fs');
var jsforce = require('jsforce');
const { Console } = require('console');
var conn = new jsforce.Connection({
    loginUrl: process.env.SFDC_URL,
    version: process.env.SFDC_APIVERSION
});

var app = express();
app.use(queue({
    activeLimit: 1,
    queuedLimit: -1
}));

app.set('port', process.env.PORT || 3000);

app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: true
})); // support encoded bodies
app.get('/health', function (req, res) {
    res.send('Heroku in Progress');
})
//Testing Input parameters from Apex...*****************************************
app.post('/testPostParams', function (req, res) {
    console.log("Request BODY ::", req.body);
    var wo_id = req.body.woid;
    // var cv_id = req.body.cvid; //
    var doc_ids = req.body.docids;

    var quotedAndCommaSeparated = "'" + doc_ids.join("','") + "'";

    //console.log("Ids SOQL", quotedAndCommaSeparated);
    res.send(wo_id + "--" + doc_ids + "--" + cv_id);
});
//******************************************************************************
//app.get('/mergeDocumentForEnt/:id/:tg', function(req, res) {
app.post('/mergeDocumentForEnt', function (req, res) {
    res.setHeader('Content-Type', 'application/json');

    var wo_id = req.body.woid;
   // var wo_id = 'a1s3N0000004lIwQAI';
   // var doc_ids = ['a1s3N0000004lIwQAI'];
    var doc_ids = req.body.docids;
    // var cv_id = req.body.cvid;// 
    
    console.log('=============== INFO Incoming request ==== ', wo_id, "---", wo_id, "---", doc_ids.length, " docs");

    var quotedAndCommaSeparated = "'" + doc_ids.join("','") + "'";
    //var WorkorderAndCommaSeparated = "'" + wo_id.join("','") + "'";  //For SOQL Query

    var filesToMerge = [];
    var filesToMergeIds = [];
    var filesQueue = [];
    var filesCreated = 0;
    var filesToCreate = 0;

    var mergedFileName = process.env.MERGED_FILENAME;
    var pdfTagMerged = process.env.MERGED_FILETAG;
    var ret = {};
    ret.result = {};
    ret.result.origDoc = wo_id;
    ret.result.targetDoc = doc_ids;
    ret.result.success = true;

    //***************************************************
    // Select ContentVersion -> Generate pdfs (fill array of files) -> Merge Pdf -> Update ContentVersion (new) with the merged pdf -> Update WO status
    //***************************************************
    conn.login(process.env.SFDC_LOGIN, process.env.SFDC_PWD, function (err, result) {
        if (err) {
            console.log("=============== SFDC AUTH ERROR -ERR1", err);
            ret.result.success = false;
            // API RETURN *************************************************
            res.send(ret);
        }
       conn.query("SELECT SMAX_PS_Report_Name_Prefix__c,SMAX_PS_Report_Name_Suffix__c  FROM SVMXC__Service_Order__c  where id IN ('"+ wo_id +"')Limit 30", function (err, result) {
            //Query Error...
            if(err){
                console.log('ERROR from query' );
                console.log(err);
                
                }
                
            console.log('Service order Data', result.records[0]);
          var ReportFormat = result.records[0].SMAX_PS_Report_Name_Prefix__c + '_FSR_' + result.records[0].SMAX_PS_Report_Name_Suffix__c;

        //Create a ContentVersion document code 
        // Single record creation
        
        let data = 'init files'; let buff = new Buffer(data); let base64data = buff.toString('base64');
        conn.sobject("ContentVersion").create({
            Title: ReportFormat ,   //ReportFormat
            PathOnClient: 'merged.pdf',
            VersionData: base64data,
            IsMajorVersion : 'false',
        },
            function (err, ret) {
                if (err || !ret.success) {
                    return console.error(err, ret);
                }
                console.log("Created record id : ", ret);
                // ...

                var cv_id = ret.id;
                //var contentdocumentId = 

                conn.sobject("ContentVersion").retrieve(cv_id, function (err, res) {
                    if (err) { return console.error(err); }
                    console.log("contentdocumentid : " + res.ContentDocumentId);
                    // var ContentDocumentId = res.ContentDocumentId;
                    // ...
                    conn.sobject("ContentDocumentlink").create({
                        ContentDocumentId: res.ContentDocumentId,
                        linkedentityId: wo_id
                    }, function (err, ret) {
                        if (err || !ret.success) {
                            return console.error(err, ret);
                        }
                        console.log("Created record id : " + ret.id);
                        // ...
                    });
                });
                //////////




                //QUERYING DOCUMENTS ************************************************************************************* 

                conn.query('SELECT ContentDocument.LatestPublishedVersion.Id, ContentDocument.LatestPublishedVersion.ExternalDocumentInfo1,ContentDocument.LatestPublishedVersion.ExternalDocumentInfo2, ContentDocument.LatestPublishedVersion.Title, ContentDocument.LatestPublishedVersion.FileExtension FROM ContentDocumentLink where LinkedEntityId IN (' + quotedAndCommaSeparated + ') and ContentDocument.FileExtension=\'pdf\' and ContentDocument.LatestPublishedVersion.ExternalDocumentInfo2 <> \'' + pdfTagMerged + '\' AND ContentDocument.LatestPublishedVersion.ExternalDocumentInfo1 != null AND ContentDocument.ContentSize > 10 and ContentDocument.LatestPublishedVersion.ExternalDocumentInfo1 != \'Merged\'  ORDER BY ContentDocument.LatestPublishedVersion.ExternalDocumentInfo1  LIMIT 30 ', function (err, result) {
                    //Query Error...
                    if (err) {
                        console.log("=============== QUERY 1 ERROR -ERR2", err);
                        ret.result.success = false;
                        // API RETURN *************************************************
                        res.send(ret);
                    }

                    filesToCreate = result.records.length;
                    if (result.records.length > 0) {
                        for (var i = 0; i < result.records.length; i++) {
                            filesToMerge.push(result.records[i].ContentDocument.LatestPublishedVersion.Id + '.' + result.records[i].ContentDocument.LatestPublishedVersion.FileExtension);
                            filesToMergeIds.push(result.records[i].ContentDocument.LatestPublishedVersion.Id);

                            filesQueue[i] = {};
                            //For each file, create a filestream *****************
                            filesQueue[i].fout = fs.createWriteStream(result.records[i].ContentDocument.LatestPublishedVersion.Id + '.' + result.records[i].ContentDocument.LatestPublishedVersion.FileExtension); // output stream to file
                            filesQueue[i].fname = result.records[i].ContentDocument.LatestPublishedVersion.Id + '.' + result.records[i].ContentDocument.LatestPublishedVersion.FileExtension;
                            //CBG***** Event on finished file generation start
                            filesQueue[i].fout.on('finish', function () {
                                //Unit Pdf file extracted *****************
                                filesCreated = filesCreated + 1;
                                console.log('=============== INFO file created! ==== ', filesCreated, "/", filesToCreate);
                                if (filesToCreate == filesCreated) {
                                    //All files have been generated, it was the last one : beginning the merge

                                    if (filesToCreate == 1) {
                                        // If only 1 file -> Directly update the target because the lib cannot merge 1 file...
                                        var sfile = filesQueue[0].fname;
                                        fs.stat(sfile, function (err, stat) {
                                            if (err == null) {
                                                console.log('=============== INFO Single File exists!!!');
                                                //File is ok, get content for uploading
                                                fs.readFile(sfile, (err, data) => {
                                                    if (err) {
                                                        console.log("=============== READFILE ERROR 1 ERR-3", err);
                                                        ret.result.success = false;
                                                        // API RETURN *************************************************
                                                        res.send(ret);
                                                    }
                                                    // Single record update
                                                    conn.sobject("ContentVersion").update({
                                                        Id: cv_id,
                                                        ExternalDocumentInfo2: pdfTagMerged,
                                                        VersionData: data.toString('base64')
                                                    }, function (err, retc) {
                                                        if (err || !retc.success) {
                                                            console.log("=============== UPDATE 1 ERR", err, retc);
                                                            ret.result.success = false;
                                                            // API RETURN *************************************************
                                                            res.send(ret);
                                                        }
                                                        console.log('=============== INFO Single Updated Successfully : ' + retc.id);

                                                        //UPDATE SERVICE ORDER FOR NOTIFY Success SVMXC__Service_Order__c wo_id
                                                        var d = new Date();

                                                        conn.sobject("SVMXC__Service_Order__c").update({
                                                            Id: wo_id,
                                                            SMAX_PS_DateTime_Docs_Merged__c: d,
                                                            SMAX_PS_Equip_Checklist_Results_Moved__c: true,
                                                            Heroku_Message__c : "Success"
                                                        }, function (err, retf) {
                                                            if (err || !retf.success) {
                                                                console.log("=============== ERROR UPDATE 2 ERR-4", err, retf);
                                                                ret.result.success = false;
                                                                // API RETURN *************************************************
                                                                res.send(ret);
                                                            }
                                                            console.log('=============== INFO SVMXC__Service_Order__c Updated Successfully : ' + wo_id);
                                                            // API RETURN *************************************************
                                                            res.send(ret);
                                                        });

                                                    });

                                                });

                                            } else if (err.code === 'ENOENT') {
                                                // file does not exist
                                                console.log('=============== ERROR Single File NOT exists!!!');
                                            } else {
                                                console.log('=============== Some other error: ', err.code);
                                            }
                                        });
                                    } else {
                                        merge(filesToMerge, cv_id + '.pdf', function (err) {
                                            //Merge Error...
                                            if (err) {
                                                console.log("=============== ERROR MERGE ERR", err);
                                                //IN CASE OF MERGING ERROR : SET SMAX_PS_Ready_for_Document_Merge__c to false to avoid looping
                                                conn.sobject("SVMXC__Service_Order__c").update({
                                                    Id: wo_id,
                                                    SMAX_PS_Ready_for_Document_Merge__c: false,
                                                    Heroku_Message__c : "Failed"
                                                }, function (err, rets) {
                                                    if (err || !rets.success) {
                                                        console.log("=============== ERROR UPDATE 6 ERR", err, rets);
                                                        ret.result.success = false;
                                                        // API RETURN *************************************************
                                                        res.send(ret);
                                                    }
                                                    console.log("=============== SVMXC__Service_Order__c Updated (Case ERROR merge 1)...", wo_id);
                                                    // API RETURN *************************************************
                                                    res.send(ret);
                                                });


                                            }

                                            console.log('=============== INFO Successfully merged!', wo_id, cv_id);
                                            fs.stat(cv_id + '.pdf', function (err, stat) {
                                                if (err == null) {
                                                    //console.log('File exists!!!');
                                                    //File is ok, get content for uploading
                                                    fs.readFile(cv_id + '.pdf', (err, data) => {
                                                        if (err) throw err;
                                                        // Single record update
                                                        conn.sobject("ContentVersion").update({
                                                            Id: cv_id,
                                                            ExternalDocumentInfo2: pdfTagMerged,
                                                            VersionData: data.toString('base64')
                                                        }, function (err, retc) {
                                                            if (err || !retc.success) {
                                                                console.log("=============== ERROR UPDATE 3 ERR", err, retc);
                                                                ret.result.success = false;
                                                                // API RETURN *************************************************
                                                                res.send(ret);
                                                            }
                                                            console.log('=============== INFO Merge Updated Successfully : ' + retc.id);

                                                            //UPDATE SERVICE ORDER FOR NOTIFY Success SVMXC__Service_Order__c wo_id
                                                            var d = new Date();

                                                            conn.sobject("SVMXC__Service_Order__c").update({
                                                                Id: wo_id,
                                                                SMAX_PS_DateTime_Docs_Merged__c: d,
                                                                SMAX_PS_Equip_Checklist_Results_Moved__c: true,
                                                                Heroku_Message__c : "Success"
                                                            }, function (err, retf) {
                                                                if (err || !retf.success) {
                                                                    console.log("=============== ERROR UPDATE 4 ERR", err, retf);
                                                                    ret.result.success = false;
                                                                    // API RETURN *************************************************
                                                                    res.send(ret);
                                                                }
                                                                console.log('=============== INFO SVMXC__Service_Order__c (2) Updated Successfully : ' + wo_id);
                                                                // API RETURN *************************************************
                                                                res.send(ret);
                                                            });

                                                        });

                                                    });

                                                } else if (err.code === 'ENOENT') {
                                                    // file does not exist
                                                    console.log('=============== ERROR Merged File NOT exists!!!');

                                                    //IN CASE OF MERGING ERROR : SET SMAX_PS_Ready_for_Document_Merge__c to false to avoid looping
                                                    conn.sobject("SVMXC__Service_Order__c").update({
                                                        Id: wo_id,
                                                        SMAX_PS_Ready_for_Document_Merge__c: false,
                                                        Heroku_Message__c : "Failed"
                                                    }, function (err, rets) {
                                                        if (err || !rets.success) {
                                                            console.log("=============== ERROR UPDATE 7 ERR", err, rets);
                                                            ret.result.success = false;
                                                            // API RETURN *************************************************
                                                            res.send(ret);
                                                        }
                                                        console.log("=============== SVMXC__Service_Order__c Updated (Case ERROR merge 2)...", wo_id);
                                                        // API RETURN *************************************************
                                                        res.send(ret);
                                                    });



                                                } else {
                                                    console.log('Some other error: ', err.code);
                                                }
                                            });

                                        });
                                        //END MERGE
                                    }
                                }
                            });
                            //CBG***** Event on finished file generation end
                            //Generate unit Pdf File
                            conn.sobject("ContentVersion").record(result.records[i].ContentDocument.LatestPublishedVersion.Id).blob('VersionData').pipe(filesQueue[i].fout);
                        }
                    } else {
                        var d = new Date();
                        console.log("=============== INFO ContentVersion Deletion...");
                        //The query return no rows, the contentVersion has to be deleted, only the contentdocument can be deleted...
                        var cdId = "";
                        conn.sobject("ContentVersion").retrieve(cv_id, function (err, cntVer) {
                            if (err) {
                                console.log("=============== ERROR RETRIEVE 1 ERR", err);
                                ret.result.success = false;
                                // API RETURN *************************************************
                                res.send(ret);
                            }
                            cdId = cntVer.ContentDocumentId;
                            conn.sobject("ContentDocument").destroy(cdId, function (err, retf) {
                                if (err || !retf.success) {
                                    console.log("=============== ERROR DELETE 1 ERR", err, retf);
                                    ret.result.success = false;
                                    // API RETURN *************************************************
                                    res.send(ret);
                                }
                                console.log("=============== INFO ContentDocument Deleted...");

                                conn.sobject("SVMXC__Service_Order__c").update({
                                    Id: wo_id,
                                    SMAX_PS_DateTime_Docs_Merged__c: d,
                                    SMAX_PS_Equip_Checklist_Results_Moved__c: true,
                                    Heroku_Message__c : "Success"
                                }, function (err, rets) {
                                    if (err || !rets.success) {
                                        console.log("=============== ERROR UPDATE 5 ERR", err, rets);
                                        ret.result.success = false;
                                        // API RETURN *************************************************
                                        res.send(ret);
                                    }
                                    console.log("SVMXC__Service_Order__c Updated (Case no merge)...", wo_id);
                                    // API RETURN *************************************************
                                    res.send(ret);
                                });

                            });

                        });

                    }

                    //List folder for debug...
                    //const testFolder = './';
                    //fs.readdirSync(testFolder).forEach(file => {
                    //console.log("File :==", file);
                    //});
                });
            }); 
         });
    });
    //***************************************************
    //res.send(ret);
});
//STARTING SERVICE...
app.listen(app.get('port'), function () {
    console.log(process.env.MERGED_FILETAG);
    console.log('Express server listening on port ' + app.get('port'));
});